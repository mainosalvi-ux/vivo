import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { Users, BarChart3, Clock, TrendingUp } from 'lucide-react';
import { motion } from 'motion/react';
import { useViewerCount } from '../hooks/useViewerCount';

export function StatsPanel({ streamData }: { streamData: any }) {
  const liveViewers = useViewerCount();
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uptime, setUptime] = useState('0h 0m');

  useEffect(() => {
    if (!streamData?.isActive || !streamData?.lastStarted) {
      setUptime('0s');
      return;
    }

    const interval = setInterval(() => {
      const start = new Date(streamData.lastStarted).getTime();
      const now = Date.now();
      const diff = Math.max(0, now - start);
      
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      
      if (h > 0) setUptime(`${h}h ${m}m`);
      else if (m > 0) setUptime(`${m}m ${s}s`);
      else setUptime(`${s}s`);
    }, 1000);

    return () => clearInterval(interval);
  }, [streamData?.isActive, streamData?.lastStarted]);

  useEffect(() => {
    // Total messages count
    const messagesUnsub = onSnapshot(collection(db, 'messages'), (snap) => {
      setTotalMessages(snap.size);
    });

    setLoading(false);
    return () => {
      messagesUnsub();
    };
  }, []);

  const stats = [
    { label: 'Espectadores en Vivo', value: liveViewers, icon: Users, color: 'text-orange-500' },
    { label: 'Mensajes Totales', value: totalMessages, icon: BarChart3, color: 'text-blue-500' },
    { label: 'Tiempo al Aire', value: uptime, icon: Clock, color: 'text-green-500' },
    { label: 'Engagement', value: '84%', icon: TrendingUp, color: 'text-purple-500' },
  ];

  if (loading) return null;

  return (
    <div className="grid grid-cols-4 gap-4 h-full">
      {stats.map((stat, i) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.1 }}
          className="bg-black/40 border border-white/5 rounded-lg p-3 flex flex-col justify-center"
        >
          <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-1">{stat.label}</span>
          <span className="text-xl font-bold stat-value">{stat.value}</span>
        </motion.div>
      ))}
    </div>
  );
}
