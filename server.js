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
let pipelineRunning = false;

/* ========================= MIDDLEWARE ========================= */


// Configuration CORS pour accepter les requêtes depuis le navigateur et le conteneur frontend
app.use(cors({ 
    origin: [
        'http://localhost:3000', 
        'http://127.0.0.1:3000', 
        'http://192.168.188.129:3000',
        'http://frontend:3000'
    ],
    credentials: true 
}));
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
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

/* ========================= UTILS ========================= */

const runSSHCommand = (conn, cmd, log) =>
    new Promise(resolve => {
        conn.exec(`${cmd}; exit`, { pty: true }, (err, stream) => {
            if (err) {
                log(`❌ SSH error: ${err.message}`);
                return resolve();
            }
            stream.on('data', d => log(`VM: ${d.toString().trim()}`));
            stream.on('end', resolve);
            stream.resume();
        });
    });

/* ========================= LOGIQUE DE ROLLBACK GIT ========================= */

const getCurrentCommit = (projectPath) => {
    return new Promise((res) => {
        exec('git rev-parse HEAD', { cwd: projectPath }, (e, stdout) => {
            res(e ? null : stdout.trim());
        });
    });
};

const gitRollback = (projectPath, commitHash, log) => {
    return new Promise((res) => {
        log(`⏪ Retour au commit stable : ${commitHash}`);
        exec(`git reset --hard ${commitHash}`, { cwd: projectPath }, (e) => {
            if (e) log(`❌ Erreur critique Rollback : ${e.message}`);
            res(!e);
        });
    });
};
/* ========================= PIPELINE ========================= */

const runFullPipeline = (repoUrl, repoName, actionType) => {
    pipelineLogs = [];
    const log = msg => {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        pipelineLogs.push(entry);
        console.log(entry);
    };

    return new Promise((resolve, reject) => {
        const workspace = path.join(__dirname, 'workspace');
        const projectPath = path.join(workspace, repoName);
        const conn = new Client();

        conn.on('ready', async () => {
            log(`Connecté à la VM — Action: ${actionType}`);

            if (actionType === 'CHECK_STATUS') {
                await runSSHCommand(conn, "uptime && docker ps", log);
                conn.end();
                return resolve();
            }

            if (actionType === 'CLEAN_VM') {
                await runSSHCommand(conn, "docker system prune -af", log);
                conn.end();
                return resolve();
            }

            if (actionType !== 'FULL_DEPLOY') {
                conn.end();
                return resolve();
            }

            log(`Déploiement de ${repoName}`);

            const fetchCmd = fs.existsSync(projectPath)
                ? `git -C ${projectPath} pull`
                : `git clone ${repoUrl} ${projectPath}`;

            const lastStableCommit = await getCurrentCommit(projectPath);

            exec(fetchCmd, { timeout: 2 * 60 * 1000 }, async (err) => {
                if (err) {
                    log(`❌ Git error: ${err.message}`);
                    conn.end();
                    return reject(err);
                }

                const services = [
                    {
                        name: 'frontend',
                        image: 'app-front:latest',
                        container: 'app-front',
                        port: '3000:80',
                        path: path.join(projectPath, 'frontend')
                    },
                    {
                        name: 'backend',
                        image: 'app-back:latest',
                        container: 'app-back',
                        port: '8080:8080',
                        path: path.join(projectPath, 'backend')
                    }
                ];

                try {
                    // ========== PHASE 1 : VÉRIFICATION DE TOUS LES SERVICES ==========
                    log("🔍 PHASE 1 : Vérification et build de tous les services...");
                    
                    for (const service of services) {
                        log(`\n📦 Vérification du service ${service.name.toUpperCase()}`);

                        if (service.name === 'backend') {
                            log("Tests unitaires...");
                            const testsOK = await new Promise(res => {
                                exec('mvn clean test', {
                                    cwd: service.path,
                                    timeout: 10 * 60 * 1000
                                }, e => {
                                    res(!e);
                                });
                            });

                            if (!testsOK) {
                                log("❌ Échec des tests. Initialisation du Rollback Git...");
                                await gitRollback(projectPath, lastStableCommit, log);
                                
                                conn.end();
                                return resolve();
                            }
                        }

                        // Build local
                        log(`Début du build de l'image ${service.image}...`);
                        await new Promise((res, rej) => {
                            exec(`docker build -t ${service.image} ${service.path}`, { timeout: 10 * 60 * 1000 }, (e, stdout, stderr) => {
                                if (e) {
                                    log(`❌ Erreur build: ${e.message}`);
                                    if (stderr) log(`Build stderr: ${stderr}`);
                                    return rej(e);
                                }
                                log(`✅ Build terminé pour ${service.image}`);
                                res();
                            });
                        });

                        // Export .tar
                        const tarPath = path.join(workspace, `${service.name}.tar`);
                        log(`Création de l'archive ${service.name}.tar...`);
                        await new Promise((res, rej) => {
                            exec(`docker save ${service.image} -o ${tarPath}`, (e) => {
                                if (e) {
                                    log(`❌ Erreur export: ${e.message}`);
                                    return rej(e);
                                }
                                const stats = fs.statSync(tarPath);
                                log(`✅ Archive créée (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                                res();
                            });
                        });
                    }

                    log("\n✅ Tous les services ont été vérifiés avec succès !");
                    log("🚀 PHASE 2 : Déploiement sur la VM...\n");

                    // ========== PHASE 2 : DÉPLOIEMENT SUR LA VM ==========
                    for (const service of services) {
                        log(`\n🚢 Déploiement du service ${service.name.toUpperCase()}`);
                        const tarPath = path.join(workspace, `${service.name}.tar`);

                        // Nettoyage VM pour ce port précis
                        log(`🧹 Nettoyage des anciens conteneurs sur le port ${service.port.split(':')[0]}...`);
                        await new Promise((res) => {
                            const cleanCmd = `ids=$(docker ps -q --filter "publish=${service.port.split(':')[0]}"); if [ ! -z "$ids" ]; then docker stop $ids && docker rm $ids; fi; exit`;
                            conn.exec(cleanCmd, (e, stream) => {
                                if (e) log(`❌ Erreur lors du nettoyage: ${e.message}`);
                                stream.on('data', (data) => log(`VM clean: ${data.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Nettoyage terminé`);
                                    res();
                                });
                                stream.resume();
                            });
                        });

                        // Transfert et Load
                        log(`Début du transfert de l'image ${service.name} vers la VM...`);
                        let bytesTransferred = 0;
                        await new Promise((res, rej) => {
                            conn.exec('docker load', (e, stream) => {
                                if (e) {
                                    log(`❌ Erreur connexion docker load: ${e.message}`);
                                    return rej(e);
                                }
                                
                                const fileStream = fs.createReadStream(tarPath);
                                const stats = fs.statSync(tarPath);
                                const totalSize = stats.size;
                                
                                fileStream.on('data', (chunk) => {
                                    bytesTransferred += chunk.length;
                                    const progress = ((bytesTransferred / totalSize) * 100).toFixed(1);
                                    if (bytesTransferred % (10 * 1024 * 1024) === 0 || bytesTransferred === totalSize) {
                                        log(`⏳ Transfert: ${progress}% (${(bytesTransferred / 1024 / 1024).toFixed(2)} MB)`);
                                    }
                                });
                                
                                fileStream.pipe(stream);
                                stream.on('data', (d) => log(`VM load: ${d.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Image ${service.name} chargée sur la VM`);
                                    res();
                                });
                                stream.on('error', (err) => {
                                    log(`❌ Erreur stream: ${err.message}`);
                                    rej(err);
                                });
                            });
                        });

                        // Lancement
                        log(`Démarrage du conteneur ${service.container}...`);
                        log(`Commande: docker run -d --name ${service.container} -p ${service.port} ${service.image}`);
                        await new Promise((res, rej) => {
                            conn.exec(`docker run -d --name ${service.container} -p ${service.port} ${service.image}; exit`, (e, stream) => {
                                if (e) {
                                    log(`❌ Erreur lancement conteneur: ${e.message}`);
                                    return rej(e);
                                }
                                stream.on('data', (data) => log(`VM run: ${data.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Conteneur ${service.container} démarré`);
                                    if (fs.existsSync(tarPath)) {
                                        fs.unlinkSync(tarPath);
                                        log(`Archive ${service.name}.tar supprimée`);
                                    }
                                    res();
                                });
                                stream.on('error', (err) => {
                                    log(`❌ Erreur stream run: ${err.message}`);
                                    rej(err);
                                });
                                stream.resume();
                            });
                        });
                        log(`✅ Service ${service.name} déployé avec succès sur port ${service.port}`);
                    }

                    conn.end();
                    log("🎉 PIPELINE FULL-STACK TERMINÉ AVEC SUCCÈS !");
                    log("Tous les services sont opérationnels sur la VM");
                    resolve();
                } catch (e) {
                    log(`❌ ${e.message}`);
                    conn.end();
                    reject(e);
                }
            });
        }).connect({
            host: process.env.VM_IP,
            username: 'debian',
            password: 'debian',
            privateKey: fs.readFileSync(path.join(__dirname, 'certs', 'id_deploy_tp2')),
            passphrase: 'debian',
            readyTimeout: 10000
        });
    });
};

/* ========================= ROUTES ========================= */

app.post('/api/pipeline/action', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    if (pipelineRunning) return res.status(409).json({ error: "Pipeline déjà en cours" });

    pipelineRunning = true;
    try {
        await runFullPipeline(req.body.repoUrl, req.body.repoName, req.body.actionType);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        pipelineRunning = false;
    }
});

app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));

app.get('/auth/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));
app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/' }),
    (req, res) => res.redirect('http://localhost:3000')
);

app.listen(PORT, () => console.log(`🚀 Serveur prêt sur ${PORT}`));

app.get('/api/user', (req, res) => {
    if (!req.user) return res.json(null);
    res.json({
        username: req.user.username,
        avatar: req.user._json.avatar_url
    });
});

app.get('/api/github/repos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    try {
        const response = await axios.get(
            'https://api.github.com/user/repos?per_page=100',
            { headers: { Authorization: `token ${req.user.accessToken}` } }
        );
        res.json(response.data.map(r => ({
            name: r.name,
            url: r.clone_url,
            canPush: r.permissions.push
        })));
    } catch (e) {
        res.status(500).send(e.message);
    }
});


/* ========================= WEBHOOK GITHUB ========================= */

app.post('/api/webhook', async (req, res) => {
    // DEBUG: log headers et body
    console.log('--- Webhook reçu ---');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));

    // 1. Vérifie que c'est bien un événement "push" sur la branche "main"
    const githubEvent = req.headers['x-github-event'];
    const isMainBranch = req.body.ref === 'refs/heads/main';

    if (githubEvent === 'push' && isMainBranch) {
        try {
            const repoUrl = req.body.repository?.clone_url;
            const repoName = req.body.repository?.name;

            console.log(`[Webhook] Push détecté sur ${repoName}. Lancement du pipeline...`);

            if (!repoUrl || !repoName) {
                console.error('[Webhook Error] repoUrl ou repoName manquant');
                return res.status(400).send('repoUrl ou repoName manquant');
            }

            // On lance le pipeline en arrière-plan (sans attendre le await pour répondre à GitHub rapidement)
            runFullPipeline(repoUrl, repoName, 'FULL_DEPLOY').catch(err => {
                console.error(`[Webhook Error] ${err.message}`);
            });

            return res.status(200).send('Pipeline auto-déployé');
        } catch (err) {
            console.error('[Webhook Exception]', err);
            return res.status(500).send('Erreur interne webhook');
        }
    }

    console.log('[Webhook] Événement ignoré:', githubEvent, req.body.ref);
    res.status(200).send('Événement ignoré');
});


// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// app.post('/api/webhook', (req, res) => {
//     try {
//             if (
//         req.headers['x-github-event'] === 'push' &&
//         req.body?.ref === 'refs/heads/main' &&
//         req.body?.repository
//     )
//     {
//             const repoUrl = req.body.repository.clone_url;
//             const repoName = req.body.repository.name;

//             runFullPipeline(repoUrl, repoName, 'FULL_DEPLOY')
//                 .catch(err => console.error('Pipeline error:', err));
//         }

//         res.status(200).send('OK');
//     } catch (e) {
//         console.error(e);
//         res.status(500).send('Webhook error');
//     }
// });

