import React, { useState, useEffect } from 'react';

function App() {
    const [user, setUser] = useState(null);
    const [status, setStatus] = useState('Prêt à lancer');
    const [step, setStep] = useState(-1); // -1: pas commencé, 0: Fetch, 1: Build, 2: Deploy

    useEffect(() => {
        fetch('http://localhost:5001/api/user', { credentials: 'include' })
            .then(res => res.json()).then(setUser);
    }, []);

    const runPipeline = async () => {
        try {
            // ÉTAPE 1 : FETCH
            setStep(0);
            setStatus('Récupération du code (Git Pull)...');
            let res = await fetch('http://localhost:5001/api/pipeline/fetch', { method: 'POST', credentials: 'include' });

            // ÉTAPE 2 : BUILD
            setStep(1);
            setStatus('Construction des images Docker localement...');
            res = await fetch('http://localhost:5001/api/pipeline/build', { method: 'POST', credentials: 'include' });

            // ÉTAPE 3 : DEPLOY
            setStep(2);
            setStatus('Connexion SSH et Déploiement sur la VM de production...');
            res = await fetch('http://localhost:5001/api/pipeline/deploy', { method: 'POST', credentials: 'include' });

            const data = await res.json();
            if (data.success) {
                setStep(3);
                setStatus('Félicitations ! L\'application est en ligne sur la VM.');
            }
        } catch (e) {
            setStatus('Échec du pipeline : ' + e.message);
        }
    };

    if (!user) return <div className="p-20 text-center"><button onClick={() => window.location.href='http://localhost:5001/auth/github'}>Connexion GitHub</button></div>;

    return (
        <div className="max-w-xl mx-auto mt-20 p-8 bg-white shadow-2xl rounded-3xl border border-gray-100">
            <h1 className="text-2xl font-black mb-6 text-gray-800">Pipeline CI/CD Sécurisé</h1>

            <div className="flex gap-2 mb-8">
                {[0, 1, 2].map(i => (
                    <div key={i} className={`h-3 flex-1 rounded-full transition-all duration-500 ${step >= i ? 'bg-indigo-600' : 'bg-gray-200'}`} />
                ))}
            </div>

            <button
                onClick={runPipeline}
                disabled={step > -1 && step < 3}
                className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg transition-all
          ${step > -1 && step < 3 ? 'bg-gray-400 animate-pulse' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {step > -1 && step < 3 ? 'Traitement en cours...' : 'Déployer vers Production'}
            </button>

            <div className="mt-8 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
                <p className="text-sm font-medium text-indigo-900 leading-relaxed">
                    <span className="font-bold uppercase text-[10px] block text-indigo-400 mb-1 tracking-widest">Journal d'activité</span>
                    {status}
                </p>
            </div>
        </div>
    );
}

export default App;