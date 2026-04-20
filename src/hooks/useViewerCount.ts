import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, getCountFromServer, Timestamp } from 'firebase/firestore';

export function useViewerCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const updateCount = async () => {
      try {
        const now = Date.now();
        const twoMinutesAgo = new Timestamp((now - 120000) / 1000, 0);
        const q = query(collection(db, 'viewers'), where('lastSeen', '>=', twoMinutesAgo));
        const snap = await getCountFromServer(q);
        setCount(snap.data().count);
      } catch (e) {
        console.error('Error fetching viewer count', e);
      }
    };

    updateCount();
    const interval = setInterval(updateCount, 30000); // Update every 30s
    return () => clearInterval(interval);
  }, []);

  return count;
}
