require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');
const { Client } = require('ssh2'); // Pour la connexion VM

const app = express();
const PORT = 5001;

// Middlewares
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// Auth GitHub
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `http://localhost:${PORT}/auth/github/callback`
}, (at, rt, profile, done) => done(null, profile)));

// --- ROUTES PIPELINE ---

// 1. FETCH
app.post('/api/pipeline/fetch', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Non autorisé" });
    const repoUrl = "https://github.com/ML-Laurane/Appli-PCS.git";
    const projectPath = path.join(__dirname, 'workspace', 'app-metier');
    if (!fs.existsSync(path.join(__dirname, 'workspace'))) fs.mkdirSync(path.join(__dirname, 'workspace'));

    const command = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;
    exec(command, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// 2. BUILD (DOCKER COMPOSE)
app.post('/api/pipeline/build', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Non autorisé" });
    const projectPath = path.join(__dirname, 'workspace', 'app-metier');
    exec(`cd ${projectPath} && docker-compose build`, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// 3. DEPLOY (SSH VERS VM)
app.post('/api/pipeline/deploy', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Non autorisé" });

    const conn = new Client();
    conn.on('ready', () => {
        // Commande : Aller dans le dossier sur la VM, Pull le code, et relancer les containers
        const deployCommand = `cd /home/ubuntu/appli-pcs && git pull && docker-compose up -d --build`;

        conn.exec(deployCommand, (err, stream) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            stream.on('close', () => {
                conn.end();
                res.json({ success: true });
            }).on('data', (data) => console.log('VM:', data.toString()));
        });
    }).connect({
        host: process.env.VM_IP,
        port: 22,
        username: 'debian',
        privateKey: fs.readFileSync(process.env.SSH_KEY)
    });
});

app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));