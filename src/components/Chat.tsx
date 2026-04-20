import React, { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { Send, MessageSquare, AlertCircle, Trash2 } from 'lucide-react';
import { Filter } from 'bad-words';
import { motion, AnimatePresence } from 'motion/react';

// @ts-ignore - Handle common CJS/ESM compatibility issue for bad-words
const filter = new (Filter || (Filter as any).default || Filter)();
// Add Spanish common bad words
const extraWords = ['pendejo', 'puto', 'boludo', 'culiao', 'concha', 'maricon', 'mierda', 'malparido', 'gonorrea'];
filter.addWords(...extraWords);

interface ChatProps {
  user: any;
}

export function Chat({ user }: ChatProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.email === 'mainosalvi@gmail.com';

  // Heartbeat for viewer count
  useEffect(() => {
    const viewerId = localStorage.getItem('viewerId') || Math.random().toString(36).substring(7);
    localStorage.setItem('viewerId', viewerId);

    const updateHeartbeat = async () => {
      try {
        await setDoc(doc(db, 'viewers', viewerId), {
          lastSeen: serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        console.error('Heartbeat error', e);
      }
    };

    updateHeartbeat();
    const interval = setInterval(updateHeartbeat, 60000); // Every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'messages'), orderBy('timestamp', 'desc'), limit(50));
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse());
      setLoading(false);
    }, (err) => {
      console.error("Chat error", err);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleDeleteMessage = async (id: string, authorEmail: string) => {
    if (!isAdmin) return;
    
    try {
      await deleteDoc(doc(db, 'messages', id));
    } catch (e: any) {
      console.error("Error deleting message:", e);
      if (e.message.includes('insufficient permissions')) {
         console.warn("Permiso denegado en Firestore para borrar este mensaje.");
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !user) return;

    // Filter logic
    let text = newMessage.trim();
    try {
      text = filter.clean(text);
    } catch (e) {
      console.warn("Filter bypass fail", e);
    }
    
    try {
      await addDoc(collection(db, 'messages'), {
        text,
        userId: user.uid,
        userName: user.displayName || 'Anónimo',
        userAvatar: user.photoURL,
        timestamp: serverTimestamp(),
      });
      setNewMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  return (
    <div id="chat-container" className="flex flex-col h-full bg-zinc-950 border-l border-white/5">
      <div className="p-4 border-b border-white/5 flex items-center justify-between bg-zinc-900/30">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-zinc-500" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-zinc-400">Chat en Vivo</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] text-zinc-600 font-bold uppercase tracking-tight">Filtro Activo</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-hide">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 opacity-20">
             <div className="w-4 h-4 rounded-full border border-white border-t-transparent animate-spin" />
             <span className="text-[8px] uppercase font-bold tracking-widest">Cargando Chat...</span>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-start justify-between group/msg"
              >
                <div className="flex gap-2 text-xs leading-relaxed overflow-hidden">
                  <span className={`font-bold shrink-0 truncate max-w-[100px] ${msg.userId === 'mainosalvi@gmail.com' || msg.userName === 'Admin' ? 'text-emerald-400' : 'text-zinc-400'}`}>
                    {msg.userName}:
                  </span>
                  <span className="text-zinc-200 break-words whitespace-pre-wrap">
                    {msg.text}
                  </span>
                </div>
                {isAdmin && (
                  <button 
                    onClick={() => handleDeleteMessage(msg.id, msg.userId)}
                    className="opacity-0 group-hover/msg:opacity-100 p-1 hover:text-red-500 transition-all text-zinc-600"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-zinc-900/50 border-t border-white/5">
        {user ? (
          <form onSubmit={handleSendMessage} className="relative">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Escribe un mensaje..."
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-[10px] focus:outline-none focus:border-emerald-500 transition-colors"
            />
            <button
              type="submit"
              disabled={!newMessage.trim()}
              className="absolute right-2 top-1.5 text-zinc-500 hover:text-emerald-400 transition-colors disabled:opacity-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <div className="text-center py-2">
            <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-bold italic">Inicia sesión para chatear</p>
          </div>
        )}
      </div>
    </div>
  );
}
