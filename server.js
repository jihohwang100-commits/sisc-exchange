const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error(err.message);
    else console.log('DB 연결 완료');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, usd_balance REAL DEFAULT 500.00)`);
    db.run(`CREATE TABLE IF NOT EXISTS portfolios (user_id TEXT, symbol TEXT DEFAULT 'SISC', shares INTEGER DEFAULT 0, avg_price REAL DEFAULT 2.00, PRIMARY KEY (user_id, symbol))`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (order_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, type TEXT, price REAL, quantity INTEGER, status TEXT DEFAULT 'OPEN', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS trades (trade_id INTEGER PRIMARY KEY AUTOINCREMENT, price REAL, quantity INTEGER, traded_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS company_info (id INTEGER PRIMARY KEY, revenue TEXT DEFAULT '$12,500,000', net_income TEXT DEFAULT '$2,100,000', eps TEXT DEFAULT '$0.42')`);
    db.run(`CREATE TABLE IF NOT EXISTS news (news_id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    db.get(`SELECT * FROM users WHERE user_id = 'admin'`, (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (user_id, is_admin, usd_balance) VALUES ('admin', 1, 0.00)`);
            db.run(`INSERT INTO portfolios (user_id, symbol, shares, avg_price) VALUES ('admin', 'SISC', 100000, 2.00)`);
            db.run(`INSERT INTO company_info (id) VALUES (1)`);
            db.run(`INSERT INTO trades (price, quantity) VALUES (2.00, 1000)`);
        }
    });
});

function matchOrders() {
    db.get(`SELECT * FROM orders WHERE type='BUY' AND status='OPEN' ORDER BY price DESC, created_at ASC LIMIT 1`, (err, buyOrder) => {
        if (!buyOrder) return;
        db.get(`SELECT * FROM orders WHERE type='SELL' AND status='OPEN' ORDER BY price ASC, created_at ASC LIMIT 1`, (err, sellOrder) => {
            if (!sellOrder) return;
            if (buyOrder.price >= sellOrder.price) {
                const tradePrice = sellOrder.price;
                const tradeQty = Math.min(buyOrder.quantity, sellOrder.quantity);

                db.serialize(() => {
                    const newBuyQty = buyOrder.quantity - tradeQty;
                    const newSellQty = sellOrder.quantity - tradeQty;
                    db.run(`UPDATE orders SET quantity = ?, status = ? WHERE order_id = ?`, [newBuyQty, newBuyQty === 0 ? 'FILLED' : 'OPEN', buyOrder.order_id]);
                    db.run(`UPDATE orders SET quantity = ?, status = ? WHERE order_id = ?`, [newSellQty, newSellQty === 0 ? 'FILLED' : 'OPEN', sellOrder.order_id]);

                    db.run(`UPDATE users SET usd_balance = usd_balance - ? WHERE user_id = ?`, [tradePrice * tradeQty, buyOrder.user_id]);
                    db.run(`INSERT INTO portfolios (user_id, symbol, shares, avg_price) VALUES (?, 'SISC', ?, ?) ON CONFLICT(user_id, symbol) DO UPDATE SET shares = shares + ?`, [buyOrder.user_id, tradeQty, tradePrice, tradeQty]);

                    db.run(`UPDATE users SET usd_balance = usd_balance + ? WHERE user_id = ?`, [tradePrice * tradeQty, sellOrder.user_id]);
                    db.run(`UPDATE portfolios SET shares = shares - ? WHERE user_id = ? AND symbol = 'SISC'`, [tradeQty, sellOrder.user_id]);

                    db.run(`INSERT INTO trades (price, quantity) VALUES (?, ?)`, [tradePrice, tradeQty]);
                    io.emit('marketUpdate');
                });
                setTimeout(matchOrders, 50);
            }
        });
    });
}

app.post('/api/login', (req, res) => {
    let { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID를 입력하세요.' });
    userId = userId.trim();

    db.get(`SELECT * FROM users WHERE user_id = ?`, [userId], (err, user) => {
        if (user) {
            res.json(user);
        } else {
            const initialCash = (userId === 'admin') ? 0.00 : 500.00;
            const isAdmin = (userId === 'admin') ? 1 : 0;
            db.run(`INSERT INTO users (user_id, is_admin, usd_balance) VALUES (?, ?, ?)`, [userId, isAdmin, initialCash], () => {
                if (isAdmin) db.run(`INSERT INTO portfolios (user_id, symbol, shares, avg_price) VALUES (?, 'SISC', 100000, 2.00)`, [userId]);
                else db.run(`INSERT INTO portfolios (user_id, symbol, shares, avg_price) VALUES (?, 'SISC', 0, 0.00)`, [userId]);
                res.json({ user_id: userId, is_admin: isAdmin, usd_balance: initialCash });
            });
        }
    });
});

app.get('/api/account/:userId', (req, res) => {
    db.get(`SELECT * FROM users WHERE user_id = ?`, [req.params.userId], (err, user) => {
        db.get(`SELECT * FROM portfolios WHERE user_id = ? AND symbol = 'SISC'`, [req.params.userId], (err, port) => {
            res.json({ user, portfolio: port || { shares: 0, avg_price: 0 } });
        });
    });
});

app.post('/api/order', (req, res) => {
    const { userId, type, price, quantity } = req.body;
    if (type === 'BUY') {
        const totalCost = price * quantity;
        db.get(`SELECT usd_balance FROM users WHERE user_id = ?`, [userId], (err, row) => {
            if (!row || row.usd_balance < totalCost) return res.status(400).json({ error: '현금이 부족합니다!' });
            db.run(`UPDATE users SET usd_balance = usd_balance - ? WHERE user_id = ?`, [totalCost, userId]);
            db.run(`INSERT INTO orders (user_id, type, price, quantity) VALUES (?, 'BUY', ?, ?)`, [userId, price, quantity], () => {
                matchOrders();
                io.emit('marketUpdate');
                res.json({ success: true });
            });
        });
    } else {
        db.get(`SELECT shares FROM portfolios WHERE user_id = ? AND symbol = 'SISC'`, [userId], (err, row) => {
            if (!row || row.shares < quantity) return res.status(400).json({ error: '보유 주식이 부족합니다!' });
            db.run(`UPDATE portfolios SET shares = shares - ? WHERE user_id = ? AND symbol = 'SISC'`, [quantity, userId]);
            db.run(`INSERT INTO orders (user_id, type, price, quantity) VALUES (?, 'SELL', ?, ?)`, [userId, price, quantity], () => {
                matchOrders();
                io.emit('marketUpdate');
                res.json({ success: true });
            });
        });
    }
});

app.get('/api/market', (req, res) => {
    db.all(`SELECT price, SUM(quantity) as qty FROM orders WHERE type='BUY' AND status='OPEN' GROUP BY price ORDER BY price DESC LIMIT 5`, (err, bids) => {
        db.all(`SELECT price, SUM(quantity) as qty FROM orders WHERE type='SELL' AND status='OPEN' GROUP BY price ORDER BY price ASC LIMIT 5`, (err, asks) => {
            db.all(`SELECT * FROM trades ORDER BY trade_id DESC LIMIT 20`, (err, trades) => {
                db.get(`SELECT * FROM company_info WHERE id = 1`, (err, company) => {
                    db.all(`SELECT * FROM news ORDER BY news_id DESC LIMIT 10`, (err, news) => {
                        res.json({ bids, asks, trades, company, news });
                    });
                });
            });
        });
    });
});

app.post('/api/admin/news', (req, res) => {
    const { userId, title, content } = req.body;
    if (userId !== 'admin') return res.status(403).json({ error: '권한이 없습니다.' });
    db.run(`INSERT INTO news (title, content) VALUES (?, ?)`, [title, content], () => {
        io.emit('marketUpdate');
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
