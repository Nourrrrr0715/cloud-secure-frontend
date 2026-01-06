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

// --- CONFIGURATION ---
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
}, (at, rt, profile, done) => done(null, profile)));

// Ajoute cette variable globale en haut de server.js
let pipelineLogs = [];

// Modifie la fonction runFullPipeline pour qu'elle remplisse les logs
const runFullPipeline = () => {
    pipelineLogs = []; // Reset au début
    pipelineLogs.push(`[${new Date().toLocaleTimeString()}] 🚀 Démarrage du pipeline...`);

    return new Promise((resolve, reject) => {
        const projectPath = path.join(__dirname, 'workspace', 'app-metier');
        const repoUrl = "https://github.com/ML-Laurane/Appli-PCS.git";

        const log = (msg) => {
            const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
            console.log(entry);
            pipelineLogs.push(entry);
        };

        log("Pulling code from GitHub...");
        const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;

        exec(fetchCmd, (err) => {
            if (err) { log("❌ Erreur Fetch"); return reject(err); }
            log("✅ Code à jour.");

            log("Building Docker images (local)...");
            exec(`cd ${projectPath} && docker compose build`, (err) => {
                if (err) { log("❌ Erreur Build"); return reject(err); }
                log("✅ Images Docker prêtes.");

                const conn = new Client();
                conn.on('ready', () => {
                    log("Connexion SSH établie avec la VM Debian.");
                    const deployCmd = `cd /home/debian/Appli-PCS && git pull && docker compose up -d --build`;
                    conn.exec(deployCmd, (err, stream) => {
                        stream.on('close', () => {
                            conn.end();
                            log("🚀 DÉPLOIEMENT TERMINÉ ! L'app est en ligne.");
                            resolve();
                        }).on('data', (data) => log(`VM: ${data.toString().trim()}`));
                    });
                }).connect({
                    host: '127.0.0.1',
                    port: 2222,
                    username: 'debian',
                    privateKey: fs.readFileSync('/Users/dev02/.ssh/id_deploy_tp')
                });
            });
        });
    });
};

// Ajoute cette route pour que le Front puisse récupérer les logs
app.get('/api/pipeline/logs', (req, res) => {
    res.json({ logs: pipelineLogs });
});

// --- ROUTE WEBHOOK (AUTOMATIQUE) ---
app.post('/api/webhook', (req, res) => {
    const event = req.headers['x-github-event'];
    const payload = req.body;

    if (event === 'push') {
        const branch = payload.ref;
        if (branch === 'refs/heads/main') {
            console.log("📢 Webhook reçu: Push sur main. Lancement du déploiement...");
            runFullPipeline()
                .then(() => console.log("✨ Auto-déploiement terminé avec succès."))
                .catch(err => console.error("❌ Échec de l'auto-déploiement:", err));
        }
    }
    res.status(200).send('OK');
});

// --- ROUTES PIPELINE (MANUEL) ---
app.post('/api/pipeline/fetch', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    // Ta logique existante...
    const projectPath = path.join(__dirname, 'workspace', 'app-metier');
    const command = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone https://github.com/ML-Laurane/Appli-PCS.git ${projectPath}`;
    exec(command, (err) => err ? res.status(500).json({success:false}) : res.json({success:true}));
});

app.post('/api/pipeline/build', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    exec(`cd ${path.join(__dirname, 'workspace', 'app-metier')} && docker compose build`, (err) =>
        err ? res.status(500).json({success:false}) : res.json({success:true}));
});

app.post('/api/pipeline/deploy', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    runFullPipeline()
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ success: false, error: err }));
});

// --- AUTH ROUTES ---
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('http://localhost:3000'));
app.get('/api/user', (req, res) => res.json(req.user || null));

app.listen(PORT, () => console.log(`Back-end prêt sur le port ${PORT}`));