import React, { useState, useEffect } from 'react';

function App() {
    const [user, setUser] = useState(null);
    const [status, setStatus] = useState('Prêt');
    const [step, setStep] = useState(-1); // -1: repos, 0: fetch, 1: build, 2: deploy, 3: fini

    useEffect(() => {
        fetch('http://localhost:5001/api/user', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setUser(data));
    }, []);

    const runPipeline = async () => {
        try {
            setStep(0);
            setStatus('Récupération du code...');
            await fetch('http://localhost:5001/api/pipeline/fetch', { method: 'POST', credentials: 'include' });

            setStep(1);
            setStatus('Build Docker local...');
            await fetch('http://localhost:5001/api/pipeline/build', { method: 'POST', credentials: 'include' });

            setStep(2);
            setStatus('Déploiement sur la VM (SSH)...');
            const res = await fetch('http://localhost:5001/api/pipeline/deploy', { method: 'POST', credentials: 'include' });
            const data = await res.json();

            if (data.success) {
                setStep(3);
                setStatus('Déploiement terminé avec succès !');
            } else {
                throw new Error(data.error);
            }
        } catch (e) {
            setStatus('Erreur : ' + e.message);
            setStep(-1);
        }
    };

    if (!user) {
        return (
            <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
                <h1 className="text-4xl font-black mb-8">Cloud Secure CI/CD</h1>
                <button onClick={() => window.location.href='http://localhost:5001/auth/github'}
                        className="bg-white text-black px-8 py-3 rounded-full font-bold hover:scale-105 transition">
                    Se connecter avec GitHub
                </button>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 p-10 font-sans text-gray-800">
            <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-xl p-8">
                <div className="flex justify-between items-center mb-10">
                    <h2 className="text-2xl font-bold">Tableau de Bord</h2>
                    <div className="flex items-center gap-3">
            <span className="text-sm font-medium bg-blue-50 text-blue-700 px-4 py-1 rounded-full border border-blue-100 italic">
              Connecté : {user.username}
            </span>
                    </div>
                </div>

                {/* Barre de progression */}
                <div className="flex gap-4 mb-10">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className={`h-2 flex-1 rounded-full transition-all duration-700 ${step >= i ? 'bg-blue-600' : 'bg-gray-100'}`} />
                    ))}
                </div>

                <button
                    onClick={runPipeline}
                    disabled={step >= 0 && step < 3}
                    className={`w-full py-4 rounded-2xl font-bold text-lg shadow-lg transition-all
            ${step >= 0 && step < 3 ? 'bg-gray-300 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                    {step >= 0 && step < 3 ? 'Opération en cours...' : 'Lancer le Pipeline de Déploiement'}
                </button>

                <div className="mt-8 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                    <p className="text-center font-mono text-sm text-gray-600">{status}</p>
                </div>
            </div>
        </div>
    );
}

export default App;