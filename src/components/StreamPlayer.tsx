import { useState, useEffect, useRef } from 'react';
import { Camera, ScreenShare, VideoOff, Maximize2, Radio, Play, TrendingUp } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { collection, onSnapshot, addDoc, doc, setDoc, getDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

interface StreamPlayerProps {
  streamData: any;
  isAdmin: boolean;
}

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
};

export function StreamPlayer({ streamData, isAdmin }: StreamPlayerProps) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [remoteMainStream, setRemoteMainStream] = useState<MediaStream | null>(null);
  const [remoteCameraStream, setRemoteCameraStream] = useState<MediaStream | null>(null);
  
  // Separate refs for different display modes
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const mainCameraRef = useRef<HTMLVideoElement>(null);
  const pipCameraRef = useRef<HTMLVideoElement>(null);
  
  // Viewer refs
  const viewerMainVideoRef = useRef<HTMLVideoElement>(null);
  const viewerPipVideoRef = useRef<HTMLVideoElement>(null);

  // Storage for currently active streams to be used inside the signalling effect
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { cameraStreamRef.current = cameraStream; }, [cameraStream]);

  // Broadcaster: Track statistics
  const [activeConnections, setActiveConnections] = useState(0);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);

  useEffect(() => { audioStreamRef.current = audioStream; }, [audioStream]);

  // Sync main screen share
  useEffect(() => {
    if (mainVideoRef.current && localStream) {
      mainVideoRef.current.srcObject = localStream;
      mainVideoRef.current.play().catch(e => console.error("Screen play fail:", e));
    }
  }, [localStream]);

  // Sync camera
  useEffect(() => {
    const activeCamera = cameraStream;
    if (activeCamera) {
       if (pipCameraRef.current && localStream) {
          pipCameraRef.current.srcObject = activeCamera;
          pipCameraRef.current.play().catch(e => console.error("PiP play fail:", e));
       } else if (mainCameraRef.current && !localStream) {
          mainCameraRef.current.srcObject = activeCamera;
          mainCameraRef.current.play().catch(e => console.error("Main cam play fail:", e));
       }
    }
  }, [cameraStream, localStream]);

  // Viewer: Sync remote streams
  useEffect(() => {
    if (viewerMainVideoRef.current && remoteMainStream) {
      viewerMainVideoRef.current.srcObject = remoteMainStream;
      viewerMainVideoRef.current.play().catch(e => console.error("Viewer main play fail:", e));
    }
  }, [remoteMainStream]);

  useEffect(() => {
    if (viewerPipVideoRef.current && remoteCameraStream) {
      viewerPipVideoRef.current.srcObject = remoteCameraStream;
      viewerPipVideoRef.current.play().catch(e => console.error("Viewer PiP play fail:", e));
    }
  }, [remoteCameraStream]);

  // ==========================================
  // WebRTC Logic: Broadcaster (Admin)
  // ==========================================
  
  // Broadcaster: Track active peer connections and their negotiation status in refs
  const activePcs = useRef<{ [key: string]: RTCPeerConnection }>({});
  const isNegotiating = useRef<{ [key: string]: boolean }>({});

  const negotiate = async (pc: RTCPeerConnection, callId: string) => {
    if (isNegotiating.current[callId]) return;
    
    try {
      isNegotiating.current[callId] = true;
      
      // Wait for signaling state to be stable before starting a new negotiation
      if (pc.signalingState !== 'stable') {
        console.log(`Broadcaster: Waiting for stable state for ${callId}...`);
        await new Promise(resolve => {
          const check = () => {
            if (pc.signalingState === 'stable') resolve(true);
            else setTimeout(check, 100);
          };
          check();
        });
      }

      console.log(`Broadcaster: Negotiating ${callId}...`);
      const offer = await pc.createOffer();
      
      // Secondary check after async offer creation
      if (pc.signalingState !== 'stable') return;

      await pc.setLocalDescription(offer);
      await updateDoc(doc(db, 'calls', callId), { 
        offer: { type: offer.type, sdp: offer.sdp },
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.error(`Broadcaster: Negotiation error for ${callId}:`, err);
    } finally {
      isNegotiating.current[callId] = false;
    }
  };

  // Effect to handle new tracks being added while people are already watching
  useEffect(() => {
    if (!isAdmin || !streamData?.isActive) return;
    
    // Batch track synchronization across all active PCs
    for (const [id, pc] of Object.entries(activePcs.current) as [string, RTCPeerConnection][]) {
      let tracksChanged = false;
      const senders = pc.getSenders();

      // Stable order: Screen share then Camera then Audio
      const streamsToAdd = [
        { stream: localStream, label: 'screen' },
        { stream: cameraStream, label: 'camera' },
        { stream: audioStream, label: 'audio' }
      ];

      streamsToAdd.forEach(({ stream }) => {
        if (!stream) return;
        stream.getTracks().forEach(track => {
          if (!senders.some(s => s.track?.id === track.id)) {
            console.log(`Broadcaster: Syncing track ${track.kind} to peer ${id}`);
            pc.addTrack(track, stream);
            tracksChanged = true;
          }
        });
      });

      if (tracksChanged) {
        negotiate(pc as RTCPeerConnection, id);
      }
    }
  }, [localStream, cameraStream, isAdmin, streamData?.isActive]);

  useEffect(() => {
    if (!isAdmin || !streamData?.isActive) {
      setActiveConnections(0);
      return;
    }

    console.log("Broadcaster: [SIGNALING] Persistent Engine Started");
    const startTime = Date.now();
    // Use client-side timestamp for query filtering since serverTimestamp() is for writes only
    const queryStartTime = new Date(startTime - 60000); // Look back 1 minute

    // Broadcaster: [SIGNALING] Persistent Engine Started
    const qRaw = query(collection(db, 'calls'));

    const unsubscribe = onSnapshot(qRaw, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const callId = change.doc.id;
          const data = change.doc.data();
          
          if (activePcs.current[callId]) return;
          
          // Relaxed freshness check: 2 minutes
          const created = data.createdAt?.toMillis?.() || Date.now();
          if (created < startTime - 120000) return; 

          console.log(`Broadcaster: [PEER] Initializing ${callId}`);
          const pc = new RTCPeerConnection(ICE_SERVERS);
          activePcs.current[callId] = pc;

          setActiveConnections(prev => prev + 1);

          // Set up tracks immediately in stable order
          const initialStreams = [localStreamRef.current, cameraStreamRef.current, audioStreamRef.current];
          initialStreams.forEach(s => {
            if (s) s.getTracks().forEach(t => pc.addTrack(t, s));
          });

          pc.onicecandidate = (e) => {
            if (e.candidate) addDoc(collection(db, 'calls', callId, 'offerCandidates'), eventToCandidate(e.candidate));
          };

          pc.onnegotiationneeded = () => negotiate(pc, callId);

          pc.onconnectionstatechange = () => {
            console.log(`Broadcaster: Connection ${callId} is ${pc.connectionState}`);
            if (['disconnected', 'closed', 'failed'].includes(pc.connectionState)) {
              setActiveConnections(prev => Math.max(0, prev - 1));
              delete activePcs.current[callId];
            }
          };

          // Final Signalling Initial Offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await updateDoc(doc(db, 'calls', callId), { 
            offer: { type: offer.type, sdp: offer.sdp },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });

          // Listen for Answer
          onSnapshot(doc(db, 'calls', callId), async (snap) => {
            const sd = snap.data();
            if (pc.signalingState === "have-local-offer" && sd?.answer) {
              try {
                await pc.setRemoteDescription(new RTCSessionDescription(sd.answer));
                console.log(`Broadcaster: [SYNC] Handshake complete with ${callId}`);
              } catch (err) {
                console.error("SDP Answer Fail:", err);
              }
            }
          });

          // Listen for Candidates
          onSnapshot(collection(db, 'calls', callId, 'answerCandidates'), (snap) => {
            snap.docChanges().forEach(c => {
              if (c.type === 'added' && pc.signalingState !== "closed") {
                pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(e => console.warn("ICE add fail (answer)", e));
              }
            });
          });
        }
      });
    });

    return () => {
      unsubscribe();
      (Object.values(activePcs.current) as RTCPeerConnection[]).forEach(pc => pc.close());
      activePcs.current = {};
      setActiveConnections(0);
    };
  }, [isAdmin, streamData?.isActive]);

  const eventToCandidate = (c: RTCIceCandidate) => ({
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex
  });

  // ==========================================
  // WebRTC Logic: Viewer
  // ==========================================
  const [viewerStarted, setViewerStarted] = useState(false);

  useEffect(() => {
    if (isAdmin || !streamData?.isActive || !viewerStarted) {
      setRemoteMainStream(null);
      setRemoteCameraStream(null);
      return;
    }

    let pc: RTCPeerConnection | null = null;
    let callId: string | null = null;
    let vCount = 0;

    const start = async () => {
      console.log("Spectator: [INIT] Signal Engine");
      pc = new RTCPeerConnection(ICE_SERVERS);

      pc.ontrack = (e) => {
        const s = e.streams[0];
        const track = e.track;
        if (track.kind === 'audio') {
          setRemoteMainStream(curr => (curr?.getAudioTracks().length ? curr : s));
          return;
        }

        // Use track labels or indices to distinguish between screen and camera
        // In our stable order: Screen is added first
        console.log(`Spectator: Received track ${track.id} (${track.label})`);
        
        if (vCount === 0) {
          setRemoteMainStream(s);
          vCount = 1;
        } else if (vCount === 1) {
          setRemoteCameraStream(s);
          vCount = 2;
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate && callId) addDoc(collection(db, 'calls', callId, 'answerCandidates'), e.candidate.toJSON());
      };

      const dr = await addDoc(collection(db, 'calls'), {
        createdAt: serverTimestamp(),
        spectatorId: Math.random().toString(36).substring(7)
      });
      callId = dr.id;

      onSnapshot(doc(db, 'calls', callId), async (snap) => {
        const sd = snap.data();
        if (pc && pc.signalingState !== "closed" && sd?.offer) {
          try {
             // Wait for stable before setting remote offer
             if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') {
                await new Promise(resolve => {
                  const check = () => {
                    if (pc!.signalingState === 'stable') resolve(true);
                    else setTimeout(check, 100);
                  };
                  check();
                });
             }

             const isNewOffer = !pc.remoteDescription || pc.remoteDescription.sdp !== sd.offer.sdp;
             if (isNewOffer) {
                console.log("Spectator: Syncing Remote Offer...");
                await pc.setRemoteDescription(new RTCSessionDescription(sd.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await updateDoc(doc(db, 'calls', callId!), { answer: { type: answer.type, sdp: answer.sdp } });
             }
          } catch (err) {
             console.error("Spectator: signal sync fail:", err);
          }
        }
      });

      onSnapshot(collection(db, 'calls', callId, 'offerCandidates'), (snap) => {
        snap.docChanges().forEach(c => {
          if (c.type === 'added' && pc && pc.signalingState !== "closed") pc.addIceCandidate(new RTCIceCandidate(c.doc.data()));
        });
      });
    };

    start();
    return () => { if (pc) pc.close(); };
  }, [isAdmin, streamData?.isActive, viewerStarted]);

  const [shareError, setShareError] = useState<string | null>(null);

  const startScreenShare = async () => {
    setShareError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setLocalStream(stream);
      stream.getTracks()[0].onended = () => setLocalStream(null);
    } catch (err: any) {
      console.error("Error sharing screen", err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setShareError("Permiso denegado para compartir pantalla. Prueba en PESTAÑA NUEVA.");
      } else {
        setShareError("Error al compartir pantalla.");
      }
    }
  };

  const startCamera = async () => {
    setShareError(null);
    try {
      // Diagnostic check
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some(d => d.kind === 'videoinput');
      if (!hasCamera) {
        setShareError("No se encontró ninguna cámara conectada.");
        return;
      }

      console.log("Getting user media...");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }, 
        audio: true 
      });
      console.log("Camera stream acquired", stream.getTracks().length);
      
      // Store audio separately to ensure it persists
      const micAudio = new MediaStream(stream.getAudioTracks());
      setAudioStream(micAudio);
      
      setCameraStream(stream);
    } catch (err: any) {
      console.error("Error starting camera:", err);
      // Fallback try: just video
      try {
        console.log("Retrying with video only...");
        const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true });
        setCameraStream(videoOnly);
      } catch (retryErr: any) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setShareError("Permiso denegado. Prueba abrir la web en una PESTAÑA NUEVA.");
        } else {
          setShareError(`Error cámara: ${retryErr.message || 'Fallo de hardware'}`);
        }
      }
    }
  };

  const stopCamera = () => {
    cameraStream?.getTracks().forEach(track => track.stop());
    setCameraStream(null);
  };

  const stopScreenShare = () => {
    localStream?.getTracks().forEach(track => track.stop());
    setLocalStream(null);
  };

  return (
    <div id="stream-player-root" className="relative w-full h-full bg-black flex items-center justify-center group overflow-hidden">
      {/* Background/Video Feed */}
      <div id="video-feed-layer" className="absolute inset-0">
        {isAdmin ? (
          localStream ? (
            <video 
              id="main-video-screen"
              key="main-screen"
              ref={mainVideoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-contain" 
            />
          ) : cameraStream ? (
            <video 
              id="main-video-camera"
              key="main-camera"
              ref={mainCameraRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-contain" 
            />
          ) : (
            <div id="stream-setup-panel" className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/50">
              <Radio className="w-16 h-16 text-zinc-800 mb-4 animate-pulse" />
              <div className="text-center space-y-4 max-w-sm px-6">
                <h2 className="text-2xl font-black uppercase tracking-tighter text-white">Panel de Emisión</h2>
                <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold leading-relaxed">
                  Conexión Estable. Esperando fuente de video.
                  <br />
                  Activa tu cámara o pantalla para comenzar la previsualización.
                </p>
                {!streamData?.isActive && (
                  <div className="pt-4">
                    <div className="inline-block px-3 py-1 bg-red-600/10 border border-red-600/20 text-red-500 text-[9px] font-bold uppercase tracking-[0.2em]">
                      Estado Actual: Sin Transmisión
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          <div id="viewer-placeholder" className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950">
            {streamData?.isActive ? (
              !viewerStarted ? (
                <div className="flex flex-col items-center gap-6 p-12 text-center max-w-md">
                   <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center border border-emerald-500/20 mb-2">
                      <Play className="w-8 h-8 text-emerald-500 fill-emerald-500" />
                   </div>
                   <div>
                      <h3 className="text-xl font-black uppercase tracking-widest text-white mb-2">STREAM EN VIVO</h3>
                      <p className="text-zinc-500 text-[10px] leading-relaxed font-bold uppercase tracking-widest">
                         El administrador está transmitiendo. Pulsa el botón para sincronizar la señal de video y audio.
                      </p>
                   </div>
                   <button 
                    id="btn-sync-viewer"
                    onClick={() => setViewerStarted(true)}
                    className="w-full bg-emerald-500 hover:bg-emerald-400 text-black py-4 font-black uppercase tracking-[0.3em] text-[10px] transition-all shadow-[0_0_50px_rgba(16,185,129,0.3)] rounded-sm group flex items-center justify-center gap-3"
                   >
                    Sincronizar Señal <TrendingUp className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
                   </button>
                </div>
              ) : remoteMainStream ? (
                <div className="relative w-full h-full">
                  <video 
                    id="viewer-remote-video"
                    ref={viewerMainVideoRef} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-contain" 
                  />
                  <div className="absolute top-4 right-4 bg-emerald-500 text-black px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-sm animate-pulse">
                    EN VIVO • SINCRONIZADO
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-20 h-20 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
                  <div className="text-center">
                    <span className="text-emerald-500 font-mono text-[10px] tracking-[0.2em] font-bold uppercase animate-pulse block mb-2">
                       ESTABLECIENDO CONEXIÓN P2P...
                    </span>
                    <p className="text-zinc-500 text-[8px] uppercase font-bold tracking-widest">Negociando señal con el administrador</p>
                  </div>
                </div>
              )
            ) : (
              <div className="text-center space-y-2 opacity-10">
                <VideoOff id="icon-standby" className="w-16 h-16 mx-auto mb-4" />
                <p className="text-xl font-bold uppercase tracking-tighter">Standby</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Admin Controls Overlay */}
      {isAdmin && (
        <div className="absolute top-4 left-4 flex flex-col gap-2 z-30">
          <div className="flex gap-2">
            {!localStream ? (
              <button
                id="btn-share-screen"
                onClick={startScreenShare}
                className="flex items-center gap-2 px-3 py-1.5 bg-zinc-100 hover:bg-white text-black text-[10px] font-bold uppercase tracking-wide shadow-lg transition-all"
              >
                <ScreenShare className="w-3 h-3" /> Compartir Pantalla
              </button>
            ) : (
              <button
                id="btn-stop-screen"
                onClick={stopScreenShare}
                className="flex items-center gap-2 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold uppercase tracking-wide shadow-lg transition-all"
              >
                <VideoOff className="w-3 h-3" /> Detener Compartir
              </button>
            )}

            {!cameraStream ? (
              <button
                id="btn-start-camera"
                onClick={startCamera}
                className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold uppercase tracking-wide shadow-lg transition-all border border-white/10"
              >
                <Camera className="w-3 h-3" /> Activar Cámara
              </button>
            ) : (
              <button
                id="btn-stop-camera"
                onClick={stopCamera}
                className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold uppercase tracking-wide shadow-lg transition-all border border-white/10"
              >
                <VideoOff className="w-3 h-3" /> Quitar Cámara
              </button>
            )}
          </div>
          
          <AnimatePresence>
            {shareError && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="bg-red-600 text-white text-[9px] font-bold uppercase tracking-widest px-2 py-1 flex items-center gap-2"
              >
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
                {shareError}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Camera PiP (Secondary view) */}
      <AnimatePresence>
        {(isAdmin && cameraStream && localStream) || (!isAdmin && remoteCameraStream && streamData?.showCamera && streamData?.isActive) ? (
          <motion.div
            id="camera-pip"
            drag={isAdmin}
            dragConstraints={{ left: -400, right: 400, top: -400, bottom: 400 }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute bottom-4 right-4 w-64 aspect-video border-2 border-emerald-500 shadow-[0_0_50px_rgba(16,185,129,0.3)] z-50 cursor-move bg-black overflow-hidden rounded-sm"
          >
            {isAdmin ? (
              <video 
                id="pip-video-admin"
                key="pip-camera-admin"
                ref={pipCameraRef} 
                autoPlay 
                playsInline 
                muted 
                className="w-full h-full object-cover" 
              />
            ) : (
               <video 
                id="pip-video-viewer"
                key="pip-camera-viewer"
                ref={viewerPipVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="w-full h-full object-cover" 
              />
            )}
            <div className="absolute top-2 left-2 flex items-center gap-2">
              <div className="bg-emerald-500 text-black px-1.5 py-0.5 rounded-[2px] text-[8px] font-black uppercase tracking-widest leading-none">
                WEB CAM
              </div>
              {isAdmin && !streamData?.showCamera && (
                <div className="bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-[2px] text-[8px] font-black uppercase tracking-widest leading-none border border-white/5 italic">
                  Solo Preview
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* "Ready to Go Live" Admin Prompt */}
      <AnimatePresence>
        {isAdmin && (localStream || cameraStream) && !streamData?.isActive && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-3"
          >
            <div className="bg-emerald-500 text-black px-4 py-2 font-black uppercase tracking-[0.2em] text-xs shadow-[0_0_40px_rgba(16,185,129,0.4)] animate-bounce">
              ¡VIDEO LISTO! PULSA "TRANSMITIR" ABAJO
            </div>
            <div className="text-[9px] text-zinc-400 font-bold uppercase tracking-widest text-center max-w-xs drop-shadow-md">
              Configura tu Título y Overlay primero. Luego inicia la señal para tus seguidores.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay Text */}
      <AnimatePresence>
        {streamData?.overlayText && (streamData?.isActive || isAdmin) && (
          <motion.div
            id="stream-overlay-text"
            initial={{ opacity: 0, y: -20, x: -20 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -20, x: -20 }}
            className="absolute top-8 left-8 z-40 flex flex-col gap-2 pointer-events-none"
          >
            {streamData?.isActive && (
              <div className="flex items-center gap-2 bg-red-600 px-2 py-0.5 rounded-sm w-fit shadow-lg">
                <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white">En Vivo</span>
              </div>
            )}
            <div className="overlay-glass px-6 py-3 rounded-lg border border-white/10 shadow-2xl backdrop-blur-md">
              <h1 className="text-3xl font-black italic tracking-tighter uppercase whitespace-pre-wrap leading-tight text-white drop-shadow-md">
                {streamData.overlayText}
              </h1>
              {isAdmin && !streamData?.isActive && (
                <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-widest mt-1">Preview Offline</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Media Player Controls Overlay */}
      <div className="absolute bottom-0 inset-x-0 h-16 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-center px-6 justify-between">
        <div className="flex items-center gap-4">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] font-mono tracking-widest uppercase text-emerald-400">Stable Connection • 1080p</span>
        </div>
        <div className="flex gap-4">
          <button className="p-1.5 hover:bg-white/10 rounded transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
