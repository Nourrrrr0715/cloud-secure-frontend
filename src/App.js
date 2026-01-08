import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [user, setUser] = useState(null);
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const logEndRef = useRef(null);

  useEffect(() => {
    fetch('http://localhost:5001/api/user', { credentials: 'include' })
      .then(res => res.json())
      .then(data => { setUser(data); if (data) fetchRepos(); });

    const interval = setInterval(() => {
      fetch('http://localhost:5001/api/pipeline/logs').then(r => r.json()).then(d => setLogs(d.logs || []));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const fetchRepos = () => {
    fetch('http://localhost:5001/api/github/repos', { credentials: 'include' })
      .then(res => res.json()).then(setRepos);
  };

  const handleAction = async (actionType) => {
    if (!selectedRepo) return alert("Sélectionnez un dépôt d'abord.");
    
    // Vérification du rôle contributeur pour Appli-PCS
    if (!selectedRepo.canPush && actionType !== 'CHECK_STATUS') {
      return alert("⛔ Accès refusé : Vous devez être contributeur du dépôt Appli-PCS pour effectuer cette action. Vous pouvez uniquement consulter les logs.");
    }
    
    setLoading(true);
    const response = await fetch('http://localhost:5001/api/pipeline/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        repoUrl: selectedRepo.url, 
        repoName: selectedRepo.name, 
        actionType,
        canPush: selectedRepo.canPush 
      }),
      credentials: 'include'
    });
    
    if (!response.ok) {
      const error = await response.json();
      alert(error.error || "Une erreur s'est produite");
    }
    
    setLoading(false);
  };

  if (!user) return (
    <div className="h-screen bg-slate-950 flex flex-col items-center justify-center text-white font-sans">
      <h1 className="text-4xl font-black mb-8">CLOUD<span className="text-blue-500">SECURE</span></h1>
      <button onClick={() => window.location.href='http://localhost:5001/auth/github'} 
              className="bg-blue-600 hover:bg-blue-700 px-10 py-4 rounded-2xl font-bold transition-all shadow-xl">
        SE CONNECTER AVEC GITHUB
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 md:p-10 font-sans text-slate-900">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row justify-between items-center mb-10 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white font-black text-xl italic">CS</div>
            <div>
              <h1 className="text-xl font-bold leading-tight">Control Panel</h1>
              <p className="text-slate-400 text-xs uppercase tracking-widest font-bold">Node: 192.168.20.128</p>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-4 md:mt-0 bg-slate-50 p-2 pr-6 rounded-2xl border border-slate-100">
            <img src={user.avatar} alt="avatar" className="w-10 h-10 rounded-xl shadow-sm" />
            <div>
              <p className="text-sm font-bold">@{user.username}</p>
              <p className="text-[10px] text-blue-600 font-bold uppercase">Connected User</p>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* REPOS LIST */}
          <div className="lg:col-span-4 space-y-6">
            <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-tighter mb-4">Your Repositories</h3>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {repos.map(repo => (
                  <button 
                    key={repo.name} 
                    onClick={() => setSelectedRepo(repo)}
                    className={`w-full text-left p-4 rounded-2xl border-2 transition-all flex justify-between items-center ${selectedRepo?.name === repo.name ? 'border-blue-500 bg-blue-50/50' : 'border-transparent bg-slate-50 hover:bg-slate-100'}`}
                  >
                    <span className="font-bold text-sm truncate pr-2">{repo.name}</span>
                    {repo.canPush ? 
                      <span className="text-[9px] bg-green-100 text-green-600 px-2 py-1 rounded-md font-bold italic">ADMIN</span> : 
                      <span className="text-[9px] bg-slate-200 text-slate-500 px-2 py-1 rounded-md font-bold italic">VIEWER</span>
                    }
                  </button>
                ))}
              </div>
            </div>

            {/* ACTIONS */}
            <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-tighter mb-4">Operations</h3>
              {selectedRepo && !selectedRepo.canPush && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-xs text-amber-800 font-semibold">⚠️ Accès restreint</p>
                  <p className="text-[10px] text-amber-700 mt-1">Vous n'êtes pas contributeur de ce dépôt. Seule la consultation est autorisée.</p>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3">
                <button onClick={() => handleAction('FULL_DEPLOY')} disabled={loading || !selectedRepo?.canPush}
                        className="py-4 bg-slate-900 text-white rounded-2xl font-bold text-sm hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed"
                        title={!selectedRepo?.canPush ? "Réservé aux contributeurs" : ""}>
                  🚀 FULL DEPLOY
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => handleAction('CHECK_STATUS')} disabled={loading}
                          className="py-3 bg-white border-2 border-slate-200 text-slate-700 rounded-2xl font-bold text-xs hover:bg-slate-50 transition-all">
                    🔍 STATUS
                  </button>
                  <button onClick={() => handleAction('CLEAN_VM')} disabled={loading || !selectedRepo?.canPush}
                          className="py-3 bg-red-50 text-red-600 rounded-2xl font-bold text-xs hover:bg-red-100 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                          title={!selectedRepo?.canPush ? "Réservé aux contributeurs" : ""}>
                    🗑️ CLEAN VM
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* LOGS TERMINAL */}
          <div className="lg:col-span-8">
            <div className="bg-[#020617] rounded-[2.5rem] shadow-2xl overflow-hidden border border-slate-800 h-full flex flex-col">
              <div className="bg-slate-900/50 px-8 py-4 border-b border-slate-800 flex justify-between items-center">
                <div className="flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/40"></div>
                  <div className="w-3 h-3 rounded-full bg-amber-500/20 border border-amber-500/40"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/40"></div>
                </div>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Live Execution Stream</span>
              </div>
              <div className="p-8 flex-1 font-mono text-sm overflow-y-auto custom-scrollbar">
                {logs.length === 0 && <p className="text-slate-700 italic">Waiting for process initiation...</p>}
                {logs.map((log, i) => (
                  <div key={i} className="mb-1 flex gap-4">
                    <span className="text-blue-500/40 shrink-0">[{i}]</span>
                    <span className="text-slate-300">{log}</span>
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