require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');
const { Client } = require('ssh2');

const app = express();
const PORT = 5001;

// Configuration Middlewares
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_temporaire',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `http://localhost:${PORT}/auth/github/callback`
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

// --- ROUTES AUTHENTIFICATION ---
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => {
    res.redirect('http://localhost:3000');
});
app.get('/api/user', (req, res) => res.json(req.user || null));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('http://localhost:3000')); });

// --- ROUTES PIPELINE ---

// 1. FETCH (Local)
app.post('/api/pipeline/fetch', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    const repoUrl = "https://github.com/ML-Laurane/Appli-PCS.git";
    const workspace = path.join(__dirname, 'workspace');
    const projectPath = path.join(workspace, 'app-metier');
    if (!fs.existsSync(workspace)) fs.mkdirSync(workspace);

    const command = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;
    exec(command, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// 2. BUILD (Local Docker Compose)
app.post('/api/pipeline/build', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    const projectPath = path.join(__dirname, 'workspace', 'app-metier');
    exec(`cd ${projectPath} && docker compose build`, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// 3. DEPLOY (SSH vers VM Debian)
app.post('/api/pipeline/deploy', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    const conn = new Client();
    conn.on('ready', () => {
        const deployCmd = `cd /home/debian/Appli-PCS && git pull && docker compose up -d --build`;
        conn.exec(deployCmd, (err, stream) => {
            if (err) return res.status(500).json({ success: false });
            stream.on('close', () => { conn.end(); res.json({ success: true }); })
                .on('data', (data) => console.log('VM:', data.toString()));
        });
    }).on('error', (err) => res.status(500).json({ success: false, error: err.message }))
        .connect({
            host: '127.0.0.1',
            port: 2222,
            username: 'debian',
            privateKey: fs.readFileSync('/Users/dev02/.ssh/id_deploy_tp'),
            readyTimeout: 20000
        });
});

app.listen(PORT, () => console.log(`Back-end prêt sur le port ${PORT}`));