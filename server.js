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

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_secret',
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

// LOGIQUE DE PIPELINE
const runSSHCommand = (conn, cmd, log) => {
    return new Promise((resolve) => {
        conn.exec(`${cmd}; exit`, { pty: true }, (err, stream) => {
            if (err) { log(`❌ Erreur: ${err.message}`); return resolve(); }
            stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
            stream.on('end', () => resolve());
            stream.resume();
        });
    });
};

const runFullPipeline = (repoUrl, repoName, actionType) => {
    pipelineLogs = [];
    const log = (msg) => {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        pipelineLogs.push(entry);
        console.log(entry);
    };

    return new Promise((resolve, reject) => {
        const workspace = path.join(__dirname, 'workspace');
        const projectPath = path.join(workspace, repoName);
        const conn = new Client();

        conn.on('ready', async () => {
            log(`📡 Connecté à la VM. Action: ${actionType}`);

            if (actionType === 'CHECK_STATUS') {
                await runSSHCommand(conn, "uptime && docker ps", log);
            } 
            else if (actionType === 'CLEAN_VM') {
                log("🧹 Nettoyage global de Docker...");
                await runSSHCommand(conn, "docker system prune -af", log);
            } 
            else if (actionType === 'FULL_DEPLOY') {
                log(`🚀 Déploiement complet de ${repoName}`);
                const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;
                
                exec(fetchCmd, async (err) => {
                    if (err) {
                        log(`❌ Erreur git: ${err.message}`);
                        conn.end();
                        return reject(err);
                    }
                    log("✅ Code récupéré. Début du Build & Transfert...");

                    const services = [
                        { name: 'frontend', image: 'app-front:latest', port: '3000:80', path: path.join(projectPath, 'frontend') },
                        { name: 'backend', image: 'app-back:latest', port: '8080:8080', path: path.join(projectPath, 'backend') }
                    ];

                    try {
                        for (const s of services) {
                            log(`� Service ${s.name}...`);
                            const tarPath = path.join(workspace, `${s.name}.tar`);
                            
                            await new Promise((res, rej) => exec(`docker build -t ${s.image} ${s.path}`, (e) => e ? rej(e) : res()));
                            log(`✅ Build ${s.name} terminé`);
                            
                            await new Promise((res, rej) => exec(`docker save ${s.image} -o ${tarPath}`, (e) => e ? rej(e) : res()));
                            log(`✅ Image ${s.name} sauvegardée`);
                            
                            log(`🔄 Arrêt des containers existants sur port ${s.port.split(':')[0]}...`);
                            await runSSHCommand(conn, `ids=$(docker ps -q --filter "publish=${s.port.split(':')[0]}"); if [ ! -z "$ids" ]; then docker stop $ids && docker rm $ids; fi`, log);
                            log(`✅ Containers existants arrêtés`);
                            
                            log(`📤 Transfert de l'image ${s.name} vers la VM...`);
                            await new Promise((res, rej) => {
                                conn.exec('docker load', (e, stream) => {
                                    if (e) { log(`❌ Erreur load: ${e.message}`); return rej(e); }
                                    
                                    let completed = false;
                                    const complete = () => {
                                        if (!completed) {
                                            completed = true;
                                            res();
                                        }
                                    };
                                    
                                    stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
                                    stream.on('close', complete);
                                    stream.on('end', complete);
                                    stream.stderr.on('data', (d) => log(`VM Error: ${d.toString().trim()}`));
                                    
                                    const fileStream = fs.createReadStream(tarPath);
                                    fileStream.on('error', (err) => {
                                        log(`❌ Erreur lecture fichier: ${err.message}`);
                                        rej(err);
                                    });
                                    
                                    fileStream.pipe(stream.stdin);
                                    fileStream.on('end', () => {
                                        stream.stdin.end();
                                    });
                                });
                            });
                            log(`✅ Image ${s.name} chargée sur VM`);
                            
                            await runSSHCommand(conn, `docker run -d -p ${s.port} ${s.image}`, log);
                            log(`✅ Container ${s.name} démarré`);
                            
                            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
                        }
                        
                        conn.end();
                        log("✨ Opération terminée.");
                        resolve();
                    } catch (e) {
                        log(`❌ Erreur: ${e.message}`);
                        conn.end();
                        reject(e);
                    }
                });
                return; // Important: ne pas exécuter conn.end() immédiatement
            }
            
            conn.end();
            log("✨ Opération terminée.");
            resolve();
        }).on('error', (err) => {
            log(`❌ Erreur de connexion SSH: ${err.message}`);
            log(`💡 Détails: ${err.level || 'N/A'}`);
            conn.end();
            reject(err);
        }).on('timeout', () => {
            log('❌ Timeout de connexion SSH');
            conn.end();
            reject(new Error('SSH connection timeout'));
        }).on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
            log('🔐 Authentification interactive requise');
            finish(['debian']);
        }).connect({
            host: process.env.VM_IP || '192.168.20.128',
            port: 22,
            username: 'debian',
            password: 'debian',
            privateKey: fs.readFileSync(path.join(__dirname, 'certs', 'id_deploy_tp2')),
            passphrase: 'debian',
            tryKeyboard: true,
            readyTimeout: 10000
        });
    });
};

// ROUTES
app.get('/api/user', async (req, res) => {
    if (!req.user) return res.json(null);
    res.json({
        username: req.user.username,
        avatar: req.user._json.avatar_url
    });
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
            canPush: r.permissions.push // C'est ici qu'on voit si tu es contributeur
        })));
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/pipeline/action', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    const { repoUrl, repoName, actionType, canPush } = req.body;
    
    // Sécurité Identités : Seul un contributeur peut déployer ou nettoyer
    if (!canPush && actionType !== 'CHECK_STATUS') {
        return res.status(403).json({ error: "Droits de contributeur requis pour cette action." });
    }

    runFullPipeline(repoUrl, repoName, actionType)
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('http://localhost:3000'));

app.listen(PORT, () => console.log(`Serveur prêt sur ${PORT}`));