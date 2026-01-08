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
const PORT = 5001;
let pipelineLogs = [];

// Configuration des chemins
const SSH_PRIVATE_KEY_PATH = path.join(__dirname, 'certs', 'id_deploy_tp2');

app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'cloud_secure_secret',
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
    profile.accessToken = accessToken;
    return done(null, profile);
}));

// --- HELPERS ---

const log = (msg) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    pipelineLogs.push(entry);
    console.log(entry);
};

const runSSHCommand = (conn, cmd) => {
    return new Promise((resolve) => {
        conn.exec(`${cmd}; exit`, { pty: true }, (err, stream) => {
            if (err) { log(`❌ Erreur SSH: ${err.message}`); return resolve(); }
            stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
            stream.on('end', () => resolve());
            stream.resume();
        });
    });
};

const rollback = async (conn, service) => {
    log(`⏪ Rollback activé pour ${service.name}...`);
    const cmd = `
        docker stop ${service.container} || true
        docker rm ${service.container} || true
        docker run -d --name ${service.container} -p ${service.port} ${service.image}:previous || true
    `;
    return runSSHCommand(conn, cmd);
};

// --- LOGIQUE DE PIPELINE FUSIONNÉE ---

const runFullPipeline = (repoUrl, repoName, actionType) => {
    pipelineLogs = [];
    return new Promise((resolve, reject) => {
        const workspace = path.join(__dirname, 'workspace');
        const projectPath = path.join(workspace, repoName);
        const conn = new Client();

        conn.on('ready', async () => {
            log(`📡 Connecté à la VM (${process.env.VM_IP}). Action: ${actionType}`);

            if (actionType === 'CHECK_STATUS') {
                await runSSHCommand(conn, "uptime && docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'");
                conn.end();
                return resolve();
            }

            if (actionType === 'CLEAN_VM') {
                log("🧹 Nettoyage global de Docker sur la VM...");
                await runSSHCommand(conn, "docker system prune -af");
                conn.end();
                return resolve();
            }

            if (actionType === 'FULL_DEPLOY') {
                log(`🚀 Pipeline lancé pour ${repoName}`);
                const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;

                exec(fetchCmd, async (err) => {
                    if (err) {
                        log(`❌ Erreur Git: ${err.message}`);
                        conn.end();
                        return reject(err);
                    }
                    log("✅ Code source récupéré.");

                    const services = [
                        { name: 'backend', image: 'app-pcs-back:latest', container: 'app-pcs-back-cont', port: '8080:8080', path: path.join(projectPath, 'backend') },
                        { name: 'frontend', image: 'app-pcs-front:latest', container: 'app-pcs-front-cont', port: '3000:80', path: path.join(projectPath, 'frontend') }
                    ];

                    try {
                        for (const s of services) {
                            log(`\n--- Service : ${s.name.toUpperCase()} ---`);

                            // TESTS & SONAR (Backend uniquement)
                            if (s.name === 'backend') {
                                log("🧪 Tests unitaires (Maven)...");
                                const testsOK = await new Promise(r => exec('mvn clean test', { cwd: s.path }, (e) => r(!e)));
                                if (!testsOK) {
                                    log("❌ Tests KO. Rollback...");
                                    await rollback(conn, s);
                                    throw new Error("Tests unitaires échoués");
                                }
                                log("✅ Tests réussis.");

                                log("📊 Analyse SonarQube...");
                                const sonarOK = await new Promise(r => exec(
                                    `mvn sonar:sonar -Dsonar.projectKey=${process.env.SONAR_PROJECT_KEY} -Dsonar.host.url=${process.env.SONAR_HOST_URL} -Dsonar.login=${process.env.SONAR_TOKEN}`,
                                    { cwd: s.path }, (e) => r(!e)
                                ));
                                if (!sonarOK) throw new Error("Qualité SonarQube insuffisante");
                                log("✅ SonarQube OK.");
                            }

                            // BUILD & EXPORT
                            log(`🔨 Build Docker ${s.image}...`);
                            await new Promise((res, rej) => exec(`docker build -t ${s.image} ${s.path}`, (e) => e ? rej(e) : res()));

                            const tarPath = path.join(workspace, `${s.name}.tar`);
                            await new Promise((res, rej) => exec(`docker save ${s.image} -o ${tarPath}`, (e) => e ? rej(e) : res()));

                            // NETTOYAGE VM & TRANSFERT
                            log(`🧹 Arrêt ancien container ${s.container}...`);
                            await runSSHCommand(conn, `docker stop ${s.container} || true && docker rm ${s.container} || true`);

                            log(`📤 Transfert vers la VM...`);
                            await new Promise((res, rej) => {
                                conn.exec('docker load', (e, stream) => {
                                    if (e) return rej(e);
                                    fs.createReadStream(tarPath).pipe(stream);
                                    stream.on('end', res);
                                });
                            });

                            // RUN
                            log(`🏃 Démarrage...`);
                            await runSSHCommand(conn, `docker run -d --name ${s.container} -p ${s.port} ${s.image}`);

                            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
                            log(`✅ ${s.name} opérationnel.`);
                        }
                        log("🎉 PIPELINE RÉUSSI !");
                        conn.end();
                        resolve();
                    } catch (e) {
                        log(`❌ Erreur fatale: ${e.message}`);
                        conn.end();
                        reject(e);
                    }
                });
            }
        }).connect({
            host: process.env.VM_IP || '127.0.0.1',
            port: 2222,
            username: 'debian',
            privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH),
            passphrase: 'debian'
        });
    });
};

// --- ROUTES ---

app.get('/api/user', (req, res) => {
    if (!req.user) return res.json(null);
    res.json({ username: req.user.username, avatar: req.user._json.avatar_url });
});

app.get('/api/github/repos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    try {
        const response = await axios.get('https://api.github.com/user/repos?per_page=100', {
            headers: { Authorization: `token ${req.user.accessToken}` }
        });
        res.json(response.data.map(r => ({
            name: r.name,
            url: r.clone_url,
            canPush: r.permissions.push // Détermine le rôle Developer/Viewer
        })));
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/pipeline/action', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    const { repoUrl, repoName, actionType, canPush } = req.body;

    // RBAC : Seul un contributeur peut déployer ou nettoyer
    if (!canPush && actionType !== 'CHECK_STATUS') {
        return res.status(403).json({ error: "Droits de contributeur requis." });
    }

    runFullPipeline(repoUrl, repoName, actionType)
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('http://localhost:3000'));

app.listen(PORT, () => console.log(`🚀 Serveur CloudSecure prêt sur le port ${PORT}`));