import React, { useState, useEffect, useRef } from 'react';

function App() {
    const [user, setUser] = useState(null);
    const [logs, setLogs] = useState([]);
    const [isDeploying, setIsDeploying] = useState(false);
    const logEndRef = useRef(null);

    // Auto-scroll pour la console
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    // Récupération de l'utilisateur et polling des logs
    useEffect(() => {
        fetch('http://localhost:5001/api/user', { credentials: 'include' })
            .then(res => res.json()).then(setUser);

        const interval = setInterval(() => {
            fetch('http://localhost:5001/api/pipeline/logs')
                .then(res => res.json())
                .then(data => setLogs(data.logs || []));
        }, 1000); // On demande les nouveaux logs chaque seconde

        return () => clearInterval(interval);
    }, []);

    const handleDeploy = async () => {
        setIsDeploying(true);
        try {
            await fetch('http://localhost:5001/api/pipeline/deploy', { method: 'POST', credentials: 'include' });
        } catch (e) {
            console.error(e);
        }
        setIsDeploying(false);
    };

    if (!user) return (
        <div className="h-screen bg-slate-950 flex items-center justify-center font-sans text-white">
            <div className="text-center">
                <h1 className="text-5xl font-extrabold mb-6 tracking-tight">Cloud<span className="text-blue-500">PCS</span></h1>
                <button onClick={() => window.location.href='http://localhost:5001/auth/github'}
                        className="bg-blue-600 hover:bg-blue-700 px-8 py-3 rounded-xl font-semibold transition-all">
                    Accéder à la plateforme
                </button>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-[#f8fafc] font-sans text-slate-900 p-8">
            <div className="max-w-5xl mx-auto">
                {/* Header */}
                <header className="flex justify-between items-center mb-10">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Production Pipeline</h1>
                        <p className="text-slate-500 text-sm">Target: Debian 12 (VirtualBox) • Port: 2222</p>
                    </div>
                    <div className="flex items-center gap-4 bg-white p-2 rounded-2xl shadow-sm border border-slate-200">
                        <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold text-xs uppercase">
                            {user.username.substring(0,2)}
                        </div>
                        <span className="text-sm font-semibold pr-2">{user.username}</span>
                    </div>
                </header>

                <div className="grid grid-cols-3 gap-8">
                    {/* Menu latéral */}
                    <div className="col-span-1 space-y-6">
                        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">Contrôles</h3>
                            <button
                                onClick={handleDeploy}
                                disabled={isDeploying}
                                className={`w-full py-4 rounded-2xl font-bold transition-all ${isDeploying ? 'bg-slate-100 text-slate-400' : 'bg-slate-900 text-white hover:bg-black shadow-lg shadow-slate-200'}`}
                            >
                                {isDeploying ? 'Déploiement...' : 'Déployer maintenant'}
                            </button>
                        </div>

                        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">Info Réseau</h3>
                            <ul className="text-sm space-y-3 font-medium">
                                <li className="flex justify-between"><span>Status:</span> <span className="text-green-500">● Live</span></li>
                                <li className="flex justify-between"><span>IP:</span> <span>127.0.0.1</span></li>
                                <li className="flex justify-between"><span>App Port:</span> <span>3000</span></li>
                            </ul>
                        </div>
                    </div>

                    {/* Console de Logs */}
                    <div className="col-span-2">
                        <div className="bg-[#0f172a] rounded-3xl shadow-2xl overflow-hidden border border-slate-800">
                            <div className="bg-slate-800/50 px-6 py-3 border-b border-slate-800 flex items-center gap-2">
                                <div className="flex gap-1.5">
                                    <div className="w-3 h-3 rounded-full bg-red-500/20" />
                                    <div className="w-3 h-3 rounded-full bg-amber-500/20" />
                                    <div className="w-3 h-3 rounded-full bg-green-500/20" />
                                </div>
                                <span className="text-slate-400 text-xs font-mono ml-4">terminal — deployment-logs</span>
                            </div>
                            <div className="p-6 h-[450px] overflow-y-auto font-mono text-sm leading-relaxed text-blue-100/80">
                                {logs.length === 0 && <p className="text-slate-600 italic">Prêt pour le déploiement...</p>}
                                {logs.map((l, i) => (
                                    <div key={i} className="mb-1">
                                        <span className="text-blue-500/50 mr-2">{'>'}</span>
                                        {l}
                                    </div>
                                ))}
                                <div ref={logEndRef} />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;