const useMysql = String(process.env.DB_ENGINE || '').toLowerCase() === 'mysql'
    || Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER);
module.exports = useMysql ? require('./mysql') : require('./sqlite');
