const db = require('../database/db');
const BlinkService = require('../services/blinkService');

async function audit() {
  const [rows] = await db.query('SELECT * FROM resellers WHERE id = 1');
  const r = rows[0];

  console.log('=== RESELLER CONFIG ===');
  console.log('wallet_type:', r.wallet_type);
  console.log('blink_wallet_id:', r.blink_wallet_id);
  console.log('binance_auto_sweep_enabled:', r.binance_auto_sweep_enabled);
  console.log('binance_sweep_threshold_usd:', r.binance_sweep_threshold_usd);

  // Get actual Blink outbound transactions
  console.log('\n=== BLINK LAST 10 TRANSACTIONS ===');
  const query = `
    query Me {
      me {
        defaultAccount {
          wallets {
            id
            walletCurrency
            balance
            transactions(first: 10) {
              edges {
                node {
                  id
                  status
                  direction
                  settlementAmount
                  settlementFee
                  createdAt
                  initiationVia {
                    ... on InitiationViaLn { paymentHash }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await BlinkService.request(r.blink_api_key, query);
    const wallets = data?.me?.defaultAccount?.wallets || [];
    for (const w of wallets) {
      if (w.walletCurrency === 'BTC') {
        console.log('BTC Wallet Balance:', w.balance, 'sats');
        const edges = w.transactions?.edges || [];
        edges.forEach(e => {
          const n = e.node;
          console.log(JSON.stringify({
            direction: n.direction,
            status: n.status,
            amount: n.settlementAmount,
            fee: n.settlementFee,
            paymentHash: n.initiationVia?.paymentHash,
            createdAt: n.createdAt
          }));
        });
      }
    }
  } catch(e) {
    console.error('Blink tx error:', e.message);
  }
}
audit().catch(e => console.error(e.message));
