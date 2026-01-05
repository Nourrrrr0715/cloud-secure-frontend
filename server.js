require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');

const app = express();
const PORT = 5001;

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET,
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

// Routes Auth
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => {
    res.redirect('http://localhost:3000');
});
app.get('/api/user', (req, res) => res.json(req.user || null));

// route pour cloner quand on appuie sur le bouton
app.post('/api/pipeline/fetch', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Non autorisé" });

    const repoUrl = "https://github.com/ML-Laurane/Appli-PCS.git";
    const workspace = path.join(__dirname, 'workspace');
    const projectPath = path.join(workspace, 'app-metier');

    if (!fs.existsSync(workspace)) fs.mkdirSync(workspace);

    const command = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;

    exec(command, (error) => {
        if (error) return res.status(500).json({ success: false, error: error.message });
        res.json({ success: true, message: "Code récupéré !" });
    });
});

app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));