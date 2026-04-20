import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { doc, updateDoc, setDoc } from 'firebase/firestore';
import { Settings, Save, Play, Square, Layout, Type, Camera } from 'lucide-react';
import { motion } from 'motion/react';

interface StreamControlsProps {
  streamData: any;
}

export function StreamControls({ streamData }: StreamControlsProps) {
  const [title, setTitle] = useState('');
  const [overlayText, setOverlayText] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (streamData) {
      setTitle(prev => prev || streamData.title || '');
      setOverlayText(prev => prev || streamData.overlayText || '');
    }
  }, [streamData]);

  const handleUpdateStream = async (newData: any) => {
    setLoading(true);
    try {
      const docRef = doc(db, 'streams', 'main');
      await setDoc(docRef, newData, { merge: true });
    } catch (err) {
      console.error("Error updating stream", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleLive = () => {
    handleUpdateStream({ isActive: !streamData?.isActive, lastStarted: new Date().toISOString() });
  };

  const saveMetadata = () => {
    handleUpdateStream({ title, overlayText });
  };

  // Auto-save with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      if (streamData && (title !== streamData.title || overlayText !== streamData.overlayText)) {
        handleUpdateStream({ title, overlayText });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [title, overlayText]);

  const toggleCameraOverlay = () => {
    handleUpdateStream({ showCamera: !streamData?.showCamera });
  };

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <div className="flex gap-2">
        <button
          onClick={saveMetadata}
          disabled={loading}
          className="bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded border border-white/5 text-[10px] font-bold uppercase tracking-widest transition-all w-48 text-left"
        >
          {loading ? 'Sincronizando...' : 'Guardar Título/Overlay'}
        </button>
        <button
          onClick={toggleCameraOverlay}
          className={`flex items-center gap-2 px-4 py-2 rounded border transition-all w-48 text-[10px] font-bold uppercase tracking-widest ${
            streamData?.showCamera 
              ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' 
              : 'bg-zinc-800 border-white/5 text-zinc-400 hover:bg-zinc-700'
          }`}
        >
          <div className={`w-2 h-2 rounded-full ${streamData?.showCamera ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
          <span>Cámara en Esquina (PiP)</span>
        </button>
      </div>

      <div className="flex gap-2">
        <div className="flex flex-col gap-1 w-48">
          <input
            id="input-stream-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título Principal"
            className="w-full bg-black border border-white/10 rounded px-2 py-1 text-[10px] focus:outline-none focus:border-emerald-500"
          />
          <input
            id="input-overlay-text"
            type="text"
            value={overlayText}
            onChange={(e) => setOverlayText(e.target.value)}
            placeholder="Texto Overlay (Pantalla)"
            className="w-full bg-black border border-white/10 rounded px-2 py-1 text-[10px] focus:outline-none focus:border-emerald-500"
          />
        </div>
        <button
          onClick={toggleLive}
          className={`flex items-center justify-center gap-2 px-4 py-2 rounded font-bold uppercase tracking-wide text-xs transition-all w-40 ${
            streamData?.isActive 
              ? 'bg-red-600 hover:bg-red-700 text-white' 
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {streamData?.isActive ? 'Terminar Stream' : 'Transmitir'}
        </button>
      </div>
    </div>
  );
}
