const express = require('express');
const cors = require('cors');
const { Low, JSONFile } = require('lowdb');
const path = require('path');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Путь к базе данных
const dbPath = path.join(__dirname, 'db.json');

// Инициализация LowDB
const adapter = new JSONFile(dbPath);
const db = new Low(adapter);

// Инициализация БД
async function initializeDB() {
    await db.read();
    
    if (!db.data) {
        db.data = {
            users: {},
            activeCrashGame: null,
            crashHistory: [],
            chatMessages: [],
            transactions: [],
            leaderboard: [],
            settings: {
                minBet: 0.01,
                maxBet: 10000,
                crashSpeed: 0.02,
                chatCooldown: 3000
            },
            stats: {
                totalUsers: 0,
                totalBets: 0,
                totalWagered: 0,
                biggestWin: 0
            }
        };
        await db.write();
    }
}

initializeDB();

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatNumber(num) {
    return parseFloat(num.toFixed(2));
}

// ========== API ЭНДПОИНТЫ ==========

// 1. ПРОВЕРКА РАБОТЫ
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Casino Database API',
        version: '1.0.0',
        endpoints: {
            users: '/api/users',
            crash: '/api/crash',
            chat: '/api/chat',
            stats: '/api/stats'
        }
    });
});

// 2. ПОЛЬЗОВАТЕЛИ
app.post('/api/users/login', async (req, res) => {
    await db.read();
    
    const { username, deviceId } = req.body;
    const userId = deviceId || generateId();
    
    // Ищем существующего пользователя
    let user = db.data.users[userId];
    
    if (!user) {
        // Создаем нового пользователя
        user = {
            id: userId,
            username: username || `Игрок_${userId.slice(-6)}`,
            balance: 1000.00,
            level: 1,
            experience: 0,
            totalBets: 0,
            totalWins: 0,
            totalWagered: 0.00,
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString(),
            color: `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`
        };
        
        db.data.users[userId] = user;
        db.data.stats.totalUsers++;
        
        await db.write();
    } else {
        // Обновляем время входа
        user.lastLogin = new Date().toISOString();
        if (username && username !== user.username) {
            user.username = username;
        }
        
        await db.write();
    }
    
    res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            balance: user.balance,
            level: user.level,
            totalBets: user.totalBets,
            totalWins: user.totalWins,
            color: user.color
        }
    });
});

app.post('/api/users/update-balance', async (req, res) => {
    await db.read();
    
    const { userId, balance, type, amount } = req.body;
    
    if (!db.data.users[userId]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const user = db.data.users[userId];
    const oldBalance = user.balance;
    
    // Обновляем баланс
    user.balance = formatNumber(balance);
    
    // Добавляем транзакцию в историю
    if (type && amount) {
        db.data.transactions.push({
            id: generateId(),
            userId,
            type,
            amount: formatNumber(amount),
            oldBalance: formatNumber(oldBalance),
            newBalance: formatNumber(balance),
            timestamp: new Date().toISOString()
        });
        
        // Обновляем статистику
        if (type === 'win') {
            user.totalWins++;
            db.data.stats.totalBets++;
            if (amount > db.data.stats.biggestWin) {
                db.data.stats.biggestWin = formatNumber(amount);
            }
        }
        if (type === 'bet') {
            user.totalBets++;
            user.totalWagered = formatNumber(user.totalWagered + amount);
            db.data.stats.totalWagered = formatNumber(db.data.stats.totalWagered + amount);
        }
    }
    
    // Обновляем лидерборд
    updateLeaderboard(user);
    
    await db.write();
    
    res.json({
        success: true,
        balance: user.balance
    });
});

// 3. ИГРА CRASH (ОБЩАЯ ДЛЯ ВСЕХ)
app.get('/api/crash/status', async (req, res) => {
    await db.read();
    
    if (!db.data.activeCrashGame) {
        // Создаем новую игру
        const crashPoint = 1.0 + Math.random() * 9.0;
        
        db.data.activeCrashGame = {
            id: generateId(),
            crashPoint: formatNumber(crashPoint),
            currentMultiplier: 1.00,
            isActive: true,
            startTime: new Date().toISOString(),
            players: [],
            bets: [],
            crashedAt: null
        };
        
        await db.write();
        
        // Запускаем таймер игры
        startCrashGame();
    }
    
    res.json(db.data.activeCrashGame);
});

app.post('/api/crash/place-bet', async (req, res) => {
    await db.read();
    
    const { userId, amount } = req.body;
    
    if (!db.data.activeCrashGame || !db.data.activeCrashGame.isActive) {
        return res.status(400).json({ error: 'Игра не активна' });
    }
    
    if (!db.data.users[userId]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (amount < db.data.settings.minBet) {
        return res.status(400).json({ 
            error: `Минимальная ставка: ${db.data.settings.minBet}`
        });
    }
    
    if (amount > db.data.settings.maxBet) {
        return res.status(400).json({ 
            error: `Максимальная ставка: ${db.data.settings.maxBet}`
        });
    }
    
    const user = db.data.users[userId];
    
    if (user.balance < amount) {
        return res.status(400).json({ error: 'Недостаточно средств' });
    }
    
    // Создаем ставку
    const betId = generateId();
    const bet = {
        id: betId,
        userId,
        username: user.username,
        amount: formatNumber(amount),
        placedAt: new Date().toISOString(),
        multiplier: 1.00,
        isActive: true,
        cashedOut: false,
        cashoutMultiplier: null,
        winAmount: 0
    };
    
    // Добавляем ставку в игру
    db.data.activeCrashGame.bets.push(bet);
    
    // Добавляем игрока если его еще нет
    if (!db.data.activeCrashGame.players.includes(userId)) {
        db.data.activeCrashGame.players.push(userId);
    }
    
    // Снимаем деньги с баланса
    user.balance = formatNumber(user.balance - amount);
    
    // Добавляем транзакцию
    db.data.transactions.push({
        id: generateId(),
        userId,
        type: 'crash_bet',
        amount: -formatNumber(amount),
        description: `Ставка в Crash: ${amount}`,
        timestamp: new Date().toISOString()
    });
    
    await db.write();
    
    res.json({
        success: true,
        betId,
        newBalance: user.balance
    });
});

app.post('/api/crash/cashout', async (req, res) => {
    await db.read();
    
    const { userId, betId } = req.body;
    
    if (!db.data.activeCrashGame) {
        return res.status(400).json({ error: 'Игра не активна' });
    }
    
    const bet = db.data.activeCrashGame.bets.find(b => 
        b.id === betId && b.userId === userId && b.isActive
    );
    
    if (!bet) {
        return res.status(400).json({ error: 'Ставка не найдена или уже завершена' });
    }
    
    const user = db.data.users[userId];
    const winAmount = formatNumber(bet.amount * db.data.activeCrashGame.currentMultiplier);
    
    // Обновляем ставку
    bet.isActive = false;
    bet.cashedOut = true;
    bet.cashoutMultiplier = db.data.activeCrashGame.currentMultiplier;
    bet.winAmount = winAmount;
    
    // Начисляем выигрыш
    user.balance = formatNumber(user.balance + winAmount);
    
    // Добавляем транзакцию
    db.data.transactions.push({
        id: generateId(),
        userId,
        type: 'crash_win',
        amount: winAmount,
        description: `Выигрыш в Crash: x${db.data.activeCrashGame.currentMultiplier.toFixed(2)}`,
        timestamp: new Date().toISOString()
    });
    
    await db.write();
    
    res.json({
        success: true,
        winAmount,
        multiplier: db.data.activeCrashGame.currentMultiplier,
        newBalance: user.balance
    });
});

// 4. ОБЩИЙ ЧАТ
app.get('/api/chat/messages', async (req, res) => {
    await db.read();
    
    const limit = parseInt(req.query.limit) || 50;
    const messages = db.data.chatMessages.slice(-limit);
    
    res.json(messages);
});

app.post('/api/chat/send', async (req, res) => {
    await db.read();
    
    const { userId, message } = req.body;
    
    if (!db.data.users[userId]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }
    
    if (message.length > 200) {
        return res.status(400).json({ error: 'Сообщение слишком длинное (макс 200 символов)' });
    }
    
    const user = db.data.users[userId];
    
    // Проверяем кулдаун
    const lastMessage = db.data.chatMessages
        .filter(m => m.userId === userId)
        .pop();
    
    if (lastMessage) {
        const lastTime = new Date(lastMessage.timestamp).getTime();
        const now = Date.now();
        const cooldown = db.data.settings.chatCooldown;
        
        if (now - lastTime < cooldown) {
            const waitTime = Math.ceil((cooldown - (now - lastTime)) / 1000);
            return res.status(429).json({ 
                error: `Подождите ${waitTime} секунд перед отправкой следующего сообщения` 
            });
        }
    }
    
    // Создаем сообщение
    const chatMessage = {
        id: generateId(),
        userId,
        username: user.username,
        message: message.trim(),
        color: user.color,
        timestamp: new Date().toISOString(),
        badges: []
    };
    
    // Добавляем бейджи
    if (user.totalWagered > 5000) chatMessage.badges.push('💰');
    if (user.totalWins > 50) chatMessage.badges.push('🎯');
    if (user.level > 5) chatMessage.badges.push('⭐');
    
    db.data.chatMessages.push(chatMessage);
    
    // Ограничиваем историю сообщений
    if (db.data.chatMessages.length > 1000) {
        db.data.chatMessages = db.data.chatMessages.slice(-500);
    }
    
    await db.write();
    
    res.json({
        success: true,
        message: chatMessage
    });
});

// 5. СТАТИСТИКА И ЛИДЕРБОРДЫ
app.get('/api/stats/leaderboard', async (req, res) => {
    await db.read();
    
    const type = req.query.type || 'balance';
    let users = Object.values(db.data.users);
    
    switch(type) {
        case 'balance':
            users.sort((a, b) => b.balance - a.balance);
            break;
        case 'wins':
            users.sort((a, b) => b.totalWins - a.totalWins);
            break;
        case 'wagered':
            users.sort((a, b) => b.totalWagered - a.totalWagered);
            break;
        case 'level':
            users.sort((a, b) => b.level - a.level);
            break;
    }
    
    const leaderboard = users.slice(0, 100).map((user, index) => ({
        rank: index + 1,
        username: user.username,
        value: type === 'balance' ? user.balance : 
               type === 'wins' ? user.totalWins :
               type === 'wagered' ? user.totalWagered : user.level,
        level: user.level,
        color: user.color,
        badges: []
    }));
    
    res.json(leaderboard);
});

app.get('/api/stats/global', async (req, res) => {
    await db.read();
    
    res.json(db.data.stats);
});

// 6. ИСТОРИЯ ИГР
app.get('/api/history/user/:userId', async (req, res) => {
    await db.read();
    
    const { userId } = req.params;
    const userTransactions = db.data.transactions
        .filter(t => t.userId === userId)
        .slice(-50);
    
    res.json(userTransactions);
});

// ========== ФУНКЦИЯ ДЛЯ ОБНОВЛЕНИЯ CRASH ИГРЫ ==========

async function startCrashGame() {
    let crashInterval = null;
    
    crashInterval = setInterval(async () => {
        await db.read();
        
        const game = db.data.activeCrashGame;
        if (!game || !game.isActive) {
            clearInterval(crashInterval);
            return;
        }
        
        // Увеличиваем множитель
        let speed = db.data.settings.crashSpeed;
        
        // Увеличиваем скорость на высоких множителях
        if (game.currentMultiplier > 3) speed *= 1.5;
        if (game.currentMultiplier > 5) speed *= 2;
        if (game.currentMultiplier > 8) speed *= 3;
        
        game.currentMultiplier = formatNumber(game.currentMultiplier + speed);
        
        // Проверяем краш
        if (game.currentMultiplier >= game.crashPoint) {
            game.isActive = false;
            game.crashedAt = new Date().toISOString();
            game.finalMultiplier = game.currentMultiplier;
            
            // Добавляем в историю
            db.data.crashHistory.push({
                id: game.id,
                crashPoint: game.crashPoint,
                finalMultiplier: game.finalMultiplier,
                startTime: game.startTime,
                endTime: game.crashedAt,
                playersCount: game.players.length,
                totalBets: game.bets.length
            });
            
            // Ограничиваем историю
            if (db.data.crashHistory.length > 100) {
                db.data.crashHistory = db.data.crashHistory.slice(-50);
            }
            
            // Авто-закрытие активных ставок
            game.bets.forEach(bet => {
                if (bet.isActive) {
                    bet.isActive = false;
                    bet.autoCashed = true;
                    bet.cashoutMultiplier = game.currentMultiplier;
                    bet.winAmount = formatNumber(bet.amount * game.currentMultiplier);
                    
                    // Начисляем выигрыш пользователю
                    const user = db.data.users[bet.userId];
                    if (user) {
                        user.balance = formatNumber(user.balance + bet.winAmount);
                        
                        // Добавляем транзакцию
                        db.data.transactions.push({
                            id: generateId(),
                            userId: bet.userId,
                            type: 'crash_auto_win',
                            amount: bet.winAmount,
                            description: `Автовыигрыш в Crash: x${game.currentMultiplier.toFixed(2)}`,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            });
            
            // Очищаем активную игру
            db.data.activeCrashGame = null;
            
            await db.write();
            clearInterval(crashInterval);
            
            // Запускаем новую игру через 10 секунд
            setTimeout(startCrashGame, 10000);
            return;
        }
        
        await db.write();
    }, 100); // Обновляем каждые 100мс
}

// ========== ФУНКЦИЯ ОБНОВЛЕНИЯ ЛИДЕРБОРДА ==========

async function updateLeaderboard(user) {
    await db.read();
    
    const existingIndex = db.data.leaderboard.findIndex(u => u.userId === user.id);
    
    if (existingIndex !== -1) {
        // Обновляем существующего пользователя
        db.data.leaderboard[existingIndex] = {
            userId: user.id,
            username: user.username,
            balance: user.balance,
            totalWins: user.totalWins,
            totalWagered: user.totalWagered,
            level: user.level,
            color: user.color
        };
    } else {
        // Добавляем нового пользователя
        db.data.leaderboard.push({
            userId: user.id,
            username: user.username,
            balance: user.balance,
            totalWins: user.totalWins,
            totalWagered: user.totalWagered,
            level: user.level,
            color: user.color
        });
    }
    
    // Сортируем по балансу
    db.data.leaderboard.sort((a, b) => b.balance - a.balance);
    
    // Ограничиваем топ 100
    db.data.leaderboard = db.data.leaderboard.slice(0, 100);
    
    await db.write();
}

// ========== ЗАПУСК СЕРВЕРА ==========

const PORT = process.env.PORT || 3001;

// Локальный запуск
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Casino Database API запущен на порту ${PORT}`);
        console.log(`📊 API доступен по адресу: http://localhost:${PORT}`);
        console.log(`💾 База данных: ${dbPath}`);
    });
}

module.exports = app;