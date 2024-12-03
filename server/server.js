const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const config = {
  bitcoinAddress: 'bc1pte4f7x5e5xpr6u2y3rr9mfynw989u9g8zlp7hg0pgc89n5tt3r7qevnwpr',
  checkInterval: 10000,
  apiBaseUrl: 'https://blockstream.info/api',
  minimumSatsForBitbar: 1641,
  dbPath: path.join(__dirname, 'transactions.db')
};

let db;

async function initializeDatabase() {
  db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      timestamp INTEGER,
      amount INTEGER,
      block_height INTEGER,
      requires_minting BOOLEAN,
      minting_status TEXT,
      sender_address TEXT,
      confirmations INTEGER,
      inscription_id TEXT,
      inscription_timestamp INTEGER
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_minting_status 
    ON transactions(minting_status)
  `);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

async function fetchTransactionDetails(txid) {
  try {
    const response = await axios.get(
      `${config.apiBaseUrl}/tx/${txid}`,
      {
        timeout: 5000,
        headers: { 'Accept': 'application/json' }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching transaction details:', error.message);
    return null;
  }
}

async function processTransaction(txDetails) {
  try {
    // Check if transaction already exists
    const existingTx = await db.get('SELECT * FROM transactions WHERE txid = ?', txDetails.txid);
    if (existingTx) {
      return null;
    }

    // Find the input address (sender)
    let senderAddress = null;
    if (txDetails.vin && txDetails.vin[0] && txDetails.vin[0].prevout) {
      senderAddress = txDetails.vin[0].prevout.scriptpubkey_address;
    }

    // Calculate total amount received to our address
    let receivedAmount = 0;
    for (const output of txDetails.vout) {
      if (output.scriptpubkey_address === config.bitcoinAddress) {
        receivedAmount += parseInt(output.value);
      }
    }

    // Only process if we actually received something
    if (receivedAmount === 0) {
      return null;
    }

    const txInfo = {
      txid: txDetails.txid,
      timestamp: Date.now(),
      amount: receivedAmount,
      block_height: txDetails.status.block_height || null,
      requires_minting: receivedAmount >= config.minimumSatsForBitbar ? 1 : 0,
      minting_status: receivedAmount >= config.minimumSatsForBitbar ? 'pending' : 'not_required',
      sender_address: senderAddress,
      confirmations: 0
    };

    // Insert into database
    await db.run(`
      INSERT INTO transactions (
        txid, timestamp, amount, block_height, requires_minting, 
        minting_status, sender_address, confirmations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txInfo.txid, txInfo.timestamp, txInfo.amount, txInfo.block_height,
        txInfo.requires_minting, txInfo.minting_status, txInfo.sender_address,
        txInfo.confirmations
      ]
    );

    if (txInfo.requires_minting && senderAddress) {
      console.log(`New transaction requiring minting: ${txDetails.txid} from ${senderAddress}`);
    }

    return txInfo;
  } catch (error) {
    console.error('Error processing transaction:', error);
    return null;
  }
}

async function monitorAddress() {
  try {
    console.log('Checking for new transactions...');
    
    // Get transactions directly with details
    const response = await axios.get(
      `${config.apiBaseUrl}/address/${config.bitcoinAddress}/txs/chain`,
      {
        timeout: 5000,
        headers: { 'Accept': 'application/json' }
      }
    );

    const transactions = response.data;
    
    for (const tx of transactions) {
      const newTx = await processTransaction(tx);
      if (newTx) {
        console.log(`New transaction: ${newTx.txid}, Amount: ${newTx.amount} sats, Sender: ${newTx.sender_address}`);
      }
    }
  } catch (error) {
    console.error('Error in monitoring process:', error);
  }
}

app.get('/', async (req, res) => {
  const transactions = await db.all('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 100');
  
  const transactionHtml = transactions.map(tx => `
    <div class="transaction">
      <strong>Transaction ID:</strong> ${tx.txid}<br>
      <strong>Amount:</strong> ${tx.amount} sats<br>
      <strong>Sender:</strong> ${tx.sender_address || 'Unknown'}<br>
      <strong>Time:</strong> ${new Date(tx.timestamp).toLocaleString()}<br>
      <strong>Status:</strong> 
      <span class="minting-status ${tx.minting_status}">
        ${tx.minting_status.charAt(0).toUpperCase() + tx.minting_status.slice(1)}
      </span><br>
      ${tx.block_height ? `<strong>Block Height:</strong> ${tx.block_height}` : 'Unconfirmed'}
      ${tx.inscription_id ? `<br><strong>Inscription ID:</strong> ${tx.inscription_id}` : ''}
    </div>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Bitcoin Transaction Monitor</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .transaction { margin: 10px 0; padding: 10px; border: 1px solid #ddd; }
          .minting-status { 
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 0.9em;
          }
          .pending { background: #fff3cd; }
          .completed { background: #d4edda; }
          .not-required { background: #e2e3e5; }
        </style>
      </head>
      <body>
        <h1>Bitcoin Transaction Monitor</h1>
        <p>Monitoring address: ${config.bitcoinAddress}</p>
        <p>Minimum sats for bitbar: ${config.minimumSatsForBitbar}</p>
        <p><a href="/qrcode">View QR Code</a></p>
        <h2>Recent Transactions:</h2>
        ${transactionHtml || 'No transactions yet.'}
      </body>
    </html>
  `);
});

app.get('/api/pending-mints', async (req, res) => {
  const pendingMints = await db.all(`
    SELECT txid, amount, timestamp, sender_address 
    FROM transactions 
    WHERE minting_status = 'pending'
    AND sender_address IS NOT NULL
  `);
  res.json(pendingMints);
});

app.post('/api/confirm-mint', async (req, res) => {
  const { txid, inscription_id } = req.body;
  
  if (!txid) {
    return res.status(400).json({ error: 'Transaction ID required' });
  }

  const transaction = await db.get('SELECT * FROM transactions WHERE txid = ?', txid);
  
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  if (transaction.minting_status === 'completed') {
    return res.status(400).json({ error: 'Transaction already minted' });
  }

  await db.run(`
    UPDATE transactions 
    SET minting_status = 'completed',
        inscription_id = ?,
        inscription_timestamp = ?
    WHERE txid = ?`,
    [inscription_id, Date.now(), txid]
  );

  console.log(`Bitbar minted for transaction ${txid} with inscription ${inscription_id}`);
  res.json({ success: true, transaction });
});

app.get('/qrcode', async (req, res) => {
  try {
    const qrCodeBuffer = await qrcode.toBuffer(config.bitcoinAddress);
    res.type('png');
    res.send(qrCodeBuffer);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).send('Error generating QR code');
  }
});

app.get('/api/status', async (req, res) => {
  const [totalCount, pendingCount] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM transactions'),
    db.get('SELECT COUNT(*) as count FROM transactions WHERE minting_status = ?', ['pending'])
  ]);

  res.json({
    totalTransactions: totalCount.count,
    pendingMints: pendingCount.count,
    uptime: process.uptime(),
    lastCheck: new Date().toISOString()
  });
});

// API endpoint to get all minted transactions
app.get('/api/minted', async (req, res) => {
  const mintedTransactions = await db.all(`
    SELECT txid, amount, timestamp, sender_address, inscription_id, inscription_timestamp
    FROM transactions 
    WHERE minting_status = 'completed'
    ORDER BY inscription_timestamp DESC
  `);
  res.json(mintedTransactions);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

async function startServer() {
  try {
    await initializeDatabase();
    
    const server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      setInterval(monitorAddress, config.checkInterval);
    });

    process.on('SIGTERM', () => {
      console.log('SIGTERM signal received: closing HTTP server');
      server.close(async () => {
        console.log('HTTP server closed');
        if (db) {
          await db.close();
          console.log('Database connection closed');
        }
      });
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on( 'unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

startServer();

module.exports = app;