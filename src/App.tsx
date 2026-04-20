/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { doc, onSnapshot, getDocFromServer, setDoc } from 'firebase/firestore';
import { auth, db, loginWithGoogle, logout } from './lib/firebase';
import { StreamPlayer } from './components/StreamPlayer';
import { Chat } from './components/Chat';
import { StreamControls } from './components/StreamControls';
import { StatsPanel } from './components/StatsPanel';
import { LogIn, LogOut, Shield, Radio, Activity, Users, WifiOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useViewerCount } from './hooks/useViewerCount';

export default function App() {
  const [user, loading] = useAuthState(auth);
  const [streamData, setStreamData] = useState<any>({
    title: 'Cargando...',
    isActive: false,
    overlayText: '',
    showCamera: false
  });
  const [showStats, setShowStats] = useState(true); // Default to true for high density
  const [connectionError, setConnectionError] = useState(false);
  const [forceReady, setForceReady] = useState(false);
  const viewerCount = useViewerCount();

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      await loginWithGoogle();
    } catch (error: any) {
      if (error.code !== 'auth/cancelled-popup-request' && error.code !== 'auth/popup-closed-by-user') {
        console.error("Login error:", error);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const isAdmin = user?.email === 'mainosalvi@gmail.com';

  // Force ready after 3 seconds to prevent getting stuck
  useEffect(() => {
    const timer = setTimeout(() => setForceReady(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let snapshotReceived = false;

    // Test Firestore connection with a small delay
    const testConnection = async () => {
      await new Promise(r => setTimeout(r, 2000)); // Give it 2s to breathe
      try {
        const streamRef = doc(db, 'streams', 'main');
        const snap = await getDocFromServer(streamRef);
        if (!snapshotReceived) setConnectionError(false);
        
        // Initialize stream document if it doesn't exist and user is admin
        if (!snap.exists() && isAdmin) {
          await setDoc(streamRef, {
            title: 'Mi Primer Stream',
            isActive: false,
            overlayText: '',
            showCamera: false,
            lastStarted: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error("Firestore connection error:", error);
        if (!snapshotReceived) setConnectionError(true);
      }
    };
    testConnection();

    const unsub = onSnapshot(doc(db, 'streams', 'main'), (snap) => {
      snapshotReceived = true;
      setConnectionError(false);
      if (snap.exists()) {
        setStreamData(snap.data());
      } else if (!isAdmin) {
        setStreamData({ title: 'Stream Hub', isActive: false });
      }
    }, (err) => {
      console.error("Stream snapshot error:", err);
      // Only set connection error if we haven't received data yet
      if (!streamData) setConnectionError(true);
    });
    return () => unsub();
  }, [isAdmin]);

  if (loading && !forceReady) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#09090b] text-white">
        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="flex flex-col items-center gap-4"
        >
          <Radio className="w-12 h-12 text-red-600 animate-pulse" />
          <span className="text-[10px] font-mono tracking-widest uppercase text-zinc-500">System.Initialize...</span>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#09090b] text-[#fafafa] font-sans">
      {/* Offline Alert */}
      <AnimatePresence>
        {connectionError && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-red-600/90 text-white px-4 py-2 flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest overflow-hidden shrink-0"
          >
            <WifiOff className="w-4 h-4" />
            <span>Falla en la conexión con la base de datos. Trabajando en modo offline.</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="h-[56px] border-ui flex items-center justify-between px-6 bg-zinc-900/50 flex-none shrink-0">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${streamData?.isActive ? 'bg-red-600 animate-pulse' : 'bg-zinc-700'}`} />
            <div className="flex flex-col">
              <span className="font-bold uppercase tracking-tighter text-lg leading-none">STREAM.HUB</span>
              <span className="text-[10px] font-mono text-zinc-500 uppercase truncate max-w-[200px]">
                {streamData?.title || 'System Offline'}
              </span>
            </div>
          </div>
          <div className="h-8 w-[1px] bg-zinc-800" />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase text-zinc-500 font-bold tracking-widest">
              {user ? (isAdmin ? 'Cuenta Administrador' : 'Espectador') : 'Visitante'}
            </span>
            <span className={`text-sm font-medium ${isAdmin ? 'text-emerald-400 italic' : 'text-zinc-400'}`}>
              {user?.email || 'No identificado'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-12">
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Espectadores</span>
            <span className="stat-value text-lg leading-none">{viewerCount.toLocaleString()}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Status</span>
            <span className={`text-sm font-bold uppercase leading-none ${streamData?.isActive ? 'text-red-500' : 'text-zinc-600'}`}>
              {streamData?.isActive ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <div className="flex flex-col items-center hidden sm:flex">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Codec</span>
            <span className="stat-value text-lg leading-none">H.264</span>
          </div>
        </div>

        <div className="flex gap-3">
          {user ? (
            <button
              onClick={logout}
              className="border-ui hover:bg-white/5 text-zinc-400 px-3 py-1.5 text-[10px] font-bold rounded uppercase tracking-wide transition-colors"
            >
              Sign Out
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={isLoggingIn}
              className={`bg-zinc-100 hover:bg-white text-black px-4 py-1.5 text-xs font-bold rounded uppercase tracking-wide transition-colors ${isLoggingIn ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {isLoggingIn ? 'Sign In...' : 'Sign In'}
            </button>
          )}
        </div>
      </header>

      {/* Middle Row */}
      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        <main id="main-content-area" className="flex-1 relative border-ui bg-black flex items-center justify-center group overflow-hidden">
          <StreamPlayer streamData={streamData} isAdmin={isAdmin} />
        </main>
        
        <aside className="w-[320px] border-ui flex flex-col bg-zinc-950 shrink-0">
          <Chat user={user} />
        </aside>
      </div>

      {/* Footer (Admin Stats & Controls) */}
      {isAdmin && (
        <footer className="h-auto min-h-[140px] border-ui bg-zinc-900 flex px-6 py-4 gap-8 shrink-0 overflow-x-auto">
          <div className="flex-1 min-w-[600px]">
             <StatsPanel streamData={streamData} />
          </div>
          <div className="w-px bg-zinc-800 shrink-0" />
          <div className="shrink-0 flex items-center">
            <StreamControls streamData={streamData} />
          </div>
        </footer>
      )}
    </div>
  );
}
