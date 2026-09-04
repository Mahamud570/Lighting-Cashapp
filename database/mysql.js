const mysql = require('mysql2/promise');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
for (const name of ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD']) if (!process.env[name]) throw new Error(`${name} is required for MySQL`);
const pool = mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,waitForConnections:true,connectionLimit:Number(process.env.DB_POOL_SIZE||8),charset:'utf8mb4',timezone:'Z',decimalNumbers:true});

function mysqlSql(sql) {
    let out=String(sql)
      .replace(/date\('now',\s*'-(\d+) days?'\)/gi,'DATE_SUB(CURDATE(), INTERVAL $1 DAY)')
      .replace(/date\('now',\s*'\+(\d+) days?'\)/gi,'DATE_ADD(CURDATE(), INTERVAL $1 DAY)')
      .replace(/date\(([^(),]+),\s*'-(\d+) days?'\)/gi,'DATE_SUB(DATE($1), INTERVAL $2 DAY)')
      .replace(/date\(([^(),]+),\s*'\+(\d+) days?'\)/gi,'DATE_ADD(DATE($1), INTERVAL $2 DAY)')
      .replace(/date\('now'\)/gi,'CURDATE()')
      .replace(/datetime\('now',\s*'-(\d+) minutes?'\)/gi,'DATE_SUB(NOW(), INTERVAL $1 MINUTE)')
      .replace(/datetime\('now',\s*'\+(\d+) minutes?'\)/gi,'DATE_ADD(NOW(), INTERVAL $1 MINUTE)')
      .replace(/datetime\('now',\s*'-(\d+) seconds?'\)/gi,'DATE_SUB(NOW(), INTERVAL $1 SECOND)')
      .replace(/datetime\('now',\s*'\+(\d+) seconds?'\)/gi,'DATE_ADD(NOW(), INTERVAL $1 SECOND)')
      .replace(/datetime\('now',\s*'-(\d+) hours?'\)/gi,'DATE_SUB(NOW(), INTERVAL $1 HOUR)')
      .replace(/datetime\('now',\s*'\+(\d+) hours?'\)/gi,'DATE_ADD(NOW(), INTERVAL $1 HOUR)')
      .replace(/datetime\('now',\s*'-(\d+) days?'\)/gi,'DATE_SUB(NOW(), INTERVAL $1 DAY)')
      .replace(/datetime\('now',\s*'\+(\d+) days?'\)/gi,'DATE_ADD(NOW(), INTERVAL $1 DAY)')
      .replace(/datetime\('now',\s*\?\)/gi,'DATE_SUB(NOW(), INTERVAL ? DAY)')
      .replace(/datetime\('now'\)/gi,'NOW()').replace(/^\s*INSERT\s+OR\s+IGNORE/i,'INSERT IGNORE')
      .replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING/gi,'ON DUPLICATE KEY UPDATE $1=$1')
      .replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET/gi,'ON DUPLICATE KEY UPDATE')
      .replace(/excluded\.([A-Za-z_][A-Za-z0-9_]*)/g,'VALUES($1)');
    if(/platform_settings/i.test(out)) out=out.replace(/\bkey\b/g,'`key`');
    return out;
}
function convertSchema(s){return s.replace(/--[^\n]*/g,'').replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi,'BIGINT PRIMARY KEY AUTO_INCREMENT').replace(/\bINTEGER\b/gi,'BIGINT').replace(/\bREAL\b/gi,'DECIMAL(20,8)').replace(/TEXT\s+UNIQUE\s+NOT NULL/gi,'VARCHAR(255) UNIQUE NOT NULL').replace(/TEXT\s+UNIQUE/gi,'VARCHAR(255) UNIQUE').replace(/TEXT\s+PRIMARY KEY/gi,'VARCHAR(191) PRIMARY KEY').replace(/TEXT\s+DEFAULT\s+'([^']*)'/gi,"VARCHAR(255) DEFAULT '$1'").replace(/TEXT\s+CHECK/gi,'VARCHAR(64) CHECK').replace(/INSERT OR IGNORE/gi,'INSERT IGNORE');}
const extras={resellers:{must_change_password:'BIGINT DEFAULT 0',payments_paused:'BIGINT DEFAULT 0',require_2fa:'BIGINT DEFAULT 0',max_payment_usd:'DECIMAL(20,8) DEFAULT 0',max_daily_volume_usd:'DECIMAL(20,8) DEFAULT 0',max_sub_users:'BIGINT DEFAULT 0',max_links:'BIGINT DEFAULT 0',internal_notes:'TEXT',tags:'TEXT',telegram_bot_token:'TEXT',telegram_chat_id:'TEXT'},sub_users:{must_change_password:'BIGINT DEFAULT 0'},payment_links:{charge_mode:"VARCHAR(32) DEFAULT 'inherit'",charge_value:'DECIMAL(20,8) DEFAULT 0',preview_mode:"VARCHAR(32) DEFAULT 'full'"},sessions:{account_type:"VARCHAR(32) DEFAULT 'reseller'",account_id:'BIGINT'},payments:{amount_sats:'BIGINT',payer_location:'TEXT',payer_note:'TEXT',receiving_wallet:'TEXT',seller_checked:'BIGINT DEFAULT 0',public_status_token:'VARCHAR(255)'},trusted_devices:{label:'VARCHAR(255)',last_used:'DATETIME DEFAULT CURRENT_TIMESTAMP',revoked_at:'DATETIME'}};
async function ensureSchema(){
 const schema=convertSchema(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
 // Repair tables left by the first MySQL build, whose primary IDs were INT
 // while its generated foreign-key columns were BIGINT. This is idempotent.
 const [existing]=await pool.query('SHOW TABLES');
 const existingNames=new Set(existing.map(row=>Object.values(row)[0]));
 for(const table of tables)if(existingNames.has(table)){
   const [cols]=await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'id'`);
   if(cols.length&&/^int(?:\(|$)/i.test(String(cols[0].Type)))await pool.query(`ALTER TABLE \`${table}\` MODIFY \`id\` BIGINT NOT NULL AUTO_INCREMENT`);
 }
 for(const stmt of schema.split(';').map(s=>s.trim()).filter(Boolean)) await pool.query(mysqlSql(stmt));
 await pool.query("ALTER TABLE `platform_wallet_fees` MODIFY `status` VARCHAR(32) NOT NULL DEFAULT 'pending'");
 const [feeIndexes]=await pool.query("SHOW INDEX FROM `platform_wallet_fees` WHERE Key_name='idx_platform_wallet_fees_due'");
 if(!feeIndexes.length)await pool.query('CREATE INDEX `idx_platform_wallet_fees_due` ON `platform_wallet_fees` (`status`,`next_retry_at`)');
 await pool.query("UPDATE `platform_settings` SET value='2026-09-20' WHERE `key`='vps_expiry_date' AND COALESCE(value,'')=''");
 await pool.query("UPDATE `platform_settings` SET value='2026-09-16' WHERE `key` IN ('hosting_expiry_date','domain_expiry_date') AND COALESCE(value,'')=''");
 await pool.query('CREATE TABLE IF NOT EXISTS trusted_devices (id BIGINT PRIMARY KEY AUTO_INCREMENT,reseller_id BIGINT NOT NULL,token_hash VARCHAR(255) NOT NULL,ip TEXT,user_agent TEXT,device_type TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,expires_at DATETIME NOT NULL,UNIQUE KEY uq_trusted_token(token_hash)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
 await pool.query('CREATE TABLE IF NOT EXISTS app_meta (`key` VARCHAR(191) PRIMARY KEY,value TEXT,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
 for(const [table,cols] of Object.entries(extras)){const [rows]=await pool.query(`SHOW COLUMNS FROM \`${table}\``);const have=new Set(rows.map(r=>r.Field));for(const [col,type] of Object.entries(cols))if(!have.has(col))await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${type}`);}
 await pool.query("UPDATE `payment_links` SET `domain`=SUBSTRING(`domain`,5) WHERE `domain` LIKE 'www.%'");
}
const tables=['resellers','sub_users','payment_links','link_clicks','payments','sessions','activities','withdrawals','payment_themes','auto_sweeps','settlement_jobs','platform_wallet_fees','wallet_sweep_locks','telegram_payment_messages','webhook_events','platform_settings','trusted_devices'];
async function migrateOnce(){
 const [done]=await pool.query("SELECT value FROM app_meta WHERE `key`='sqlite_migrated'"); if(done.length)return;
 const file=path.join(__dirname,'../data/lightning_pay.db'); if(!fs.existsSync(file))return;
 const SQL=await initSqlJs(); const sqlite=new SQL.Database(fs.readFileSync(file)); const c=await pool.getConnection();
 try{await c.query('SET FOREIGN_KEY_CHECKS=0');await c.beginTransaction();for(const table of tables){let r;try{r=sqlite.exec(`SELECT * FROM ${table}`);}catch(_){continue}if(!r[0])continue;const [destCols]=await c.query(`SHOW COLUMNS FROM \`${table}\``);const allowed=new Set(destCols.map(x=>x.Field));const indexes=r[0].columns.map((name,index)=>({name,index})).filter(x=>allowed.has(x.name));if(!indexes.length)continue;const names=indexes.map(x=>`\`${x.name}\``).join(',');const marks=indexes.map(()=>'?').join(',');for(const row of r[0].values)await c.query(`INSERT IGNORE INTO \`${table}\` (${names}) VALUES (${marks})`,indexes.map(x=>row[x.index]));}await c.query("INSERT INTO app_meta (`key`,value) VALUES ('sqlite_migrated',NOW())");await c.commit();}
 catch(e){await c.rollback();throw e}finally{await c.query('SET FOREIGN_KEY_CHECKS=1');c.release();sqlite.close();}
}
const ready=(async()=>{await pool.query('SELECT 1');await ensureSchema();await migrateOnce();console.log('✅ MariaDB initialized; durable persistence enabled.');})();
function mysqlParams(sql, params) {
    const values = Array.isArray(params) ? params.flat().map(v => v === undefined ? null : v) : [];
    if (/datetime\('now',\s*\?\)/i.test(String(sql))) {
        return values.map(v => typeof v === 'string' && /^-\d+ days?$/i.test(v.trim())
            ? Math.abs(parseInt(v, 10))
            : v);
    }
    return values;
}
module.exports={query:async(sql,params=[])=>{await ready;return pool.query(mysqlSql(sql),mysqlParams(sql,params))},end:()=>pool.end(),mysqlSql,mysqlParams};
