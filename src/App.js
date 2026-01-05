import React, { useState, useEffect } from 'react';

function App() {
    const [user, setUser] = useState(null);
    const [status, setStatus] = useState('Prêt');
    const [step, setStep] = useState(-1);

    useEffect(() => {
        fetch('http://localhost:5001/api/user', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setUser(data))
            .catch(() => setStatus("Serveur hors ligne"));
    }, []);

    const startFetch = async () => {
        setStep(0);
        setStatus('Clonage en cours...');
        try {
            const res = await fetch('http://localhost:5001/api/pipeline/fetch', { method: 'POST', credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                setStatus('Code récupéré avec succès !');
                setStep(1);
            } else { setStatus('Erreur : ' + data.error); }
        } catch (e) { setStatus('Erreur serveur'); }
    };

    if (!user) {
        return (
            <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
                <h1 className="text-3xl font-bold mb-6">CI/CD Sécurisé - Connexion</h1>
                <button onClick={() => window.location.href='http://localhost:5001/auth/github'}
                        className="bg-white text-black px-6 py-2 rounded-lg font-bold hover:bg-gray-200">
                    Se connecter avec GitHub
                </button>
            </div>
        );
    }

    return (
        <div className="p-10 bg-gray-50 min-h-screen font-sans">
            <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl shadow-lg">
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-xl font-bold">Pipeline Dashboard</h2>
                    <span className="text-sm bg-blue-100 text-blue-800 px-3 py-1 rounded-full">User: {user.username}</span>
                </div>

                <div className="flex gap-4 mb-8">
                    <div className={`flex-1 h-2 rounded ${step >= 0 ? 'bg-blue-600' : 'bg-gray-200'}`}></div>
                    <div className={`flex-1 h-2 rounded ${step >= 1 ? 'bg-blue-600' : 'bg-gray-200'}`}></div>
                    <div className={`flex-1 h-2 rounded ${step >= 2 ? 'bg-blue-600' : 'bg-gray-200'}`}></div>
                </div>

                <button onClick={startFetch} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700">
                    Lancer l'Étape 4 : Récupérer le code
                </button>
                <p className="mt-4 text-center text-gray-500 italic">{status}</p>
            </div>
        </div>
    );
}

export default App;