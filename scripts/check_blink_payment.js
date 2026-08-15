const BlinkService = require('../services/blinkService');

async function main() {
    const apiKey = 'blink_rPgVncESLFjFLUo2NYnsL2ExkDjNYoKB9gzoi5cN1OEECdB8lxO5230PdwzFrF3f';
    const paymentHash = 'df0e1ec500d8a46f8c7e877cc2b05cc3ad95982de3a7b752d3b0d1a522668837';

    console.log('1. Checking wallet details & balance...');
    const wallet = await BlinkService.getWalletDetails({ apiKey });
    console.log('Wallet Details:', JSON.stringify(wallet, null, 2));

    console.log('\n2. Checking transactions...');
    const txQuery = `
        query Me {
            me {
                defaultAccount {
                    wallets {
                        id
                        walletCurrency
                        balance
                        transactions(first: 5) {
                            edges {
                                node {
                                    id
                                    status
                                    settlementAmount
                                    settlementCurrency
                                    createdAt
                                    initiationVia {
                                        ... on InitiationViaLn {
                                            paymentHash
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    const txRes = await BlinkService.request(apiKey, txQuery);
    console.log('Transactions:', JSON.stringify(txRes, null, 2));
}

main().catch(err => {
    console.error('Error details:', err.response ? err.response.data : err.message);
});
