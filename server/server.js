const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode'); // Import qrcode package

const app = express();
const PORT = 3000;

// Your Bitcoin address to monitor
const bitcoinAddress = 'bc1pte4f7x5e5xpr6u2y3rr9mfynw989u9g8zlp7hg0pgc89n5tt3r7qevnwpr';

// A Set to track processed transaction IDs
let processedTransactionIds = new Set();

// Function to fetch transactions for a Bitcoin address
async function fetchTransactions(address) {
    try {
        // Use Blockstream API to fetch transactions for the address
        const response = await axios.get(`https://blockstream.info/api/address/${address}/txs`);
        return response.data;
    } catch (error) {
        console.error('Error fetching transactions:', error.message);
        return [];
    }
}

// Monitor the Bitcoin address periodically
async function monitorAddress() {
    console.log('Checking for new transactions...');
    const transactions = await fetchTransactions(bitcoinAddress);

    if (transactions.length > 0) {
        transactions.forEach((transaction) => {
            // Check if this transaction has already been processed
            if (!processedTransactionIds.has(transaction.txid)) {
                processedTransactionIds.add(transaction.txid); // Mark as processed
                console.log('New transaction detected:', transaction.txid);

                // Find outputs sent to the monitored address
                transaction.vout.forEach((output) => {
                    if (output.scriptpubkey_address === bitcoinAddress) {
                        console.log(
                            `Received ${output.value} sats in transaction ${transaction.txid}`
                        );
                    }
                });

                // Further processing for the transaction can go here
            }
        });
    } else {
        console.log('No transactions found.');
    }
}

// Start periodic monitoring every 10 seconds
setInterval(monitorAddress, 10000);

// Express route to display processed transaction IDs
app.get('/', (req, res) => {
    res.send(
        `Processed transactions for ${bitcoinAddress}: <br>` +
        Array.from(processedTransactionIds).join('<br>') ||
        'None yet'
    );
});

// Express route to generate and display the QR code for the Bitcoin address
app.get('/qrcode', async (req, res) => {
    try {
        const qrCodeBuffer = await qrcode.toBuffer(bitcoinAddress);
        res.type('png');
        res.send(qrCodeBuffer);
    } catch (error) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
