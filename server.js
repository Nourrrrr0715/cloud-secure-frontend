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
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5001;
let pipelineLogs = [];

// --- CONFIGURATION ---
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'top_secret_pcs',
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
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken; // Stockage du token pour l'API GitHub
    return done(null, profile);
}));

// --- UTILS ---
const log = (msg) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    pipelineLogs.push(entry);
    console.log(entry);
};

const runSSHCommand = (conn, cmd) => {
    return new Promise((resolve) => {
        conn.exec(`${cmd}; exit`, (err, stream) => {
            if (err) { log(`❌ Erreur SSH: ${err.message}`); return resolve(); }
            stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
            stream.on('end', () => resolve());
            stream.resume();
        });
    });
};

// --- LOGIQUE PIPELINE ---
const runFullPipeline = (repoUrl, repoName, actionType = 'FULL_DEPLOY') => {
    pipelineLogs = []; // Reset logs
    const workspace = path.join(__dirname, 'workspace');
    if (!fs.existsSync(workspace)) fs.mkdirSync(workspace);

    return new Promise((resolve, reject) => {
        const conn = new Client();
        const projectPath = path.join(workspace, repoName);

        conn.on('ready', async () => {
            log(`📡 Connecté à la VM (${process.env.VM_IP}). Action: ${actionType}`);

            try {
                if (actionType === 'CHECK_STATUS') {
                    await runSSHCommand(conn, "uptime && docker ps");
                }
                else if (actionType === 'CLEAN_VM') {
                    log("🧹 Nettoyage global de la VM...");
                    await runSSHCommand(conn, "docker system prune -af");
                }
                else if (actionType === 'FULL_DEPLOY') {
                    log(`🚀 Déploiement complet de ${repoName}`);

                    // 1. Git Pull/Clone
                    const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;
                    await new Promise((res, rej) => exec(fetchCmd, (e) => e ? rej(e) : res()));
                    log("✅ Code source mis à jour.");

                    const services = [
                        { name: 'backend', image: 'app-pcs-back:latest', port: '8080:8080', path: path.join(projectPath, 'backend') },
                        { name: 'frontend', image: 'app-pcs-front:latest', port: '3000:80', path: path.join(projectPath, 'frontend') }
                    ];

                    for (const s of services) {
                        log(`\n--- Service : ${s.name.toUpperCase()} ---`);

                        // 2. Tests & Qualité (Backend uniquement)
                        if (s.name === 'backend' && fs.existsSync(path.join(s.path, 'pom.xml'))) {
                            log("🧪 Lancement des tests unitaires Maven...");
                            await new Promise((res, rej) => exec('mvn clean test', { cwd: s.path }, (e) => e ? rej(new Error("Tests KO")) : res()));
                            log("✅ Tests unitaires réussis.");

                            log("📊 Analyse SonarQube...");
                            const sonarCmd = `mvn sonar:sonar -Dsonar.projectKey=${process.env.SONAR_PROJECT_KEY} -Dsonar.host.url=${process.env.SONAR_HOST_URL} -Dsonar.login=${process.env.SONAR_TOKEN}`;
                            await new Promise((res, rej) => exec(sonarCmd, { cwd: s.path }, (e) => e ? rej(new Error("Sonar KO")) : res()));
                            log("✅ Analyse SonarQube terminée.");
                        }

                        // 3. Build Docker local
                        log(`🔨 Build de l'image ${s.image}...`);
                        await new Promise((res, rej) => exec(`docker build -t ${s.image} ${s.path}`, (e) => e ? rej(e) : res()));

                        // 4. Export & Transfert
                        const tarPath = path.join(workspace, `${s.name}.tar`);
                        log(`📦 Exportation vers ${s.name}.tar...`);
                        await new Promise((res, rej) => exec(`docker save ${s.image} -o ${tarPath}`, (e) => e ? rej(e) : res()));

                        log(`🧹 Nettoyage port ${s.port.split(':')[0]} sur VM...`);
                        await runSSHCommand(conn, `docker stop ${s.name}-cont || true && docker rm ${s.name}-cont || true`);

                        log(`📤 Transfert de l'image vers la VM...`);
                        await new Promise((res, rej) => {
                            conn.exec('docker load', (e, stream) => {
                                if (e) return rej(e);
                                fs.createReadStream(tarPath).pipe(stream);
                                stream.on('end', res);
                                stream.on('error', rej);
                            });
                        });

                        log(`🏃 Démarrage du conteneur ${s.name}-cont...`);
                        await runSSHCommand(conn, `docker run -d --name ${s.name}-cont -p ${s.port} ${s.image}`);

                        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
                        log(`✅ Service ${s.name} déployé.`);
                    }
                }
                log("🎉 Opération terminée avec succès !");
                conn.end();
                resolve();
            } catch (err) {
                log(`❌ Erreur critique: ${err.message}`);
                conn.end();
                reject(err);
            }
        }).connect({
            host: process.env.VM_IP,
            port: 22,
            username: 'debian',
            privateKey: fs.readFileSync(path.join(__dirname, 'certs', 'id_deploy_tp')), // Vérifiez le chemin du certificat
            passphrase: 'debian'
        });
    });
};

// --- ROUTES API ---

// Liste des repos de l'utilisateur
app.get('/api/github/repos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    try {
        const response = await axios.get('https://api.github.com/user/repos?per_page=100', {
            headers: { Authorization: `token ${req.user.accessToken}` }
        });
        res.json(response.data.map(r => ({
            name: r.name,
            url: r.clone_url,
            canPush: r.permissions.push // Sécurité : l'utilisateur a-t-il le droit d'écrire ?
        })));
    } catch (e) { res.status(500).send(e.message); }
});

// Déclenchement manuel (Interface Web)
app.post('/api/pipeline/action', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Non authentifié" });

    const { repoUrl, repoName, actionType, canPush } = req.body;

    // Sécurité : Seul un contributeur peut modifier la VM
    if (!canPush && actionType !== 'CHECK_STATUS') {
        return res.status(403).json({ error: "Droits de contributeur requis." });
    }

    runFullPipeline(repoUrl, repoName, actionType)
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ success: false, reason: err.message }));
});

// Webhook GitHub (Automatique)
app.post('/api/webhook', (req, res) => {
    const isMain = req.body.ref === 'refs/heads/main';
    if (req.headers['x-github-event'] === 'push' && isMain) {
        log("⚓ Webhook reçu : Push sur main detecté.");
        runFullPipeline(req.body.repository.clone_url, req.body.repository.name, 'FULL_DEPLOY')
            .catch(e => console.error("Erreur Webhook:", e));
    }
    res.status(200).send('OK');
});

app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));

app.get('/api/user', (req, res) => {
    if (!req.user) return res.json(null);
    res.json({
        username: req.user.username,
        avatar: req.user._json.avatar_url
    });
});

// --- AUTHENTIFICATION ---
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));

app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/' }),
    (req, res) => res.redirect('http://localhost:3000')
);

app.listen(PORT, () => console.log(`🚀 Serveur CI/CD prêt sur le port ${PORT}`));