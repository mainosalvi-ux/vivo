import { useState, useEffect, useRef } from 'react';
import { Camera, ScreenShare, VideoOff, Maximize2, Radio } from 'lucide-react';
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

  // Broadcaster: Track active listener connections
  const pcs = useRef<{ [key: string]: RTCPeerConnection }>({});
  
  // Storage for currently active streams to be used inside the signalling effect
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { cameraStreamRef.current = cameraStream; }, [cameraStream]);

  // Sync main screen share
  useEffect(() => {
    if (mainVideoRef.current && localStream) {
      mainVideoRef.current.srcObject = localStream;
      mainVideoRef.current.play().catch(e => console.error("Screen play fail:", e));
    }
  }, [localStream]);

  // Sync camera (Main view)
  useEffect(() => {
    if (mainCameraRef.current && cameraStream && !localStream) {
      mainCameraRef.current.srcObject = cameraStream;
      mainCameraRef.current.play().catch(e => console.error("Camera main play fail:", e));
    }
  }, [cameraStream, localStream]);

  // Sync camera (PiP view)
  useEffect(() => {
    if (pipCameraRef.current && cameraStream && localStream) {
      pipCameraRef.current.srcObject = cameraStream;
      pipCameraRef.current.play().catch(e => console.error("Camera PiP play fail:", e));
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
  useEffect(() => {
    if (!isAdmin || !streamData?.isActive) return;

    console.log("Admin listening for viewer calls (stabilized)...");

    // Listen for incoming viewer connection requests ("calls")
    const docThreshold = new Date(Date.now() - 300000); // 5 mins ago
    const q = query(collection(db, 'calls'), where('createdAt', '>=', docThreshold));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const callId = change.doc.id;
          const data = change.doc.data();
          
          if (!data.offer && !pcs.current[callId]) {
            console.log("Processing viewer connection request:", callId);
            const pc = new RTCPeerConnection(ICE_SERVERS);
            pcs.current[callId] = pc;

            // Add all available tracks from refs (Broadcaster Side)
            if (localStreamRef.current) {
              localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
            }
            if (cameraStreamRef.current) {
              cameraStreamRef.current.getTracks().forEach(track => pc.addTrack(track, cameraStreamRef.current!));
            }

            pc.onicecandidate = (event) => {
              if (event.candidate) {
                addDoc(collection(db, 'calls', callId, 'offerCandidates'), event.candidate.toJSON());
              }
            };

            const offerDescription = await pc.createOffer();
            await pc.setLocalDescription(offerDescription);

            await updateDoc(doc(db, 'calls', callId), {
              offer: { type: offerDescription.type, sdp: offerDescription.sdp }
            });

            // Listen for answer
            onSnapshot(doc(db, 'calls', callId), async (docSnapshot) => {
              const docData = docSnapshot.data();
              if (pc.signalingState !== "closed" && !pc.currentRemoteDescription && docData?.answer) {
                console.log("Received answer from viewer", callId);
                await pc.setRemoteDescription(new RTCSessionDescription(docData.answer));
              }
            });

            // Listen for viewer candidates
            onSnapshot(collection(db, 'calls', callId, 'answerCandidates'), (candSnapshot) => {
              candSnapshot.docChanges().forEach((candChange) => {
                if (candChange.type === 'added' && pc.signalingState !== "closed") {
                  pc.addIceCandidate(new RTCIceCandidate(candChange.doc.data()));
                }
              });
            });
          }
        }
      });
    }, (err) => console.error("Admin Signaling Error:", err));

    return () => {
      unsubscribe();
      (Object.values(pcs.current) as RTCPeerConnection[]).forEach(pc => pc.close());
      pcs.current = {};
    };
  }, [isAdmin, streamData?.isActive]);

  // ==========================================
  // WebRTC Logic: Viewer
  // ==========================================
  useEffect(() => {
    if (isAdmin || !streamData?.isActive) {
      setRemoteMainStream(null);
      setRemoteCameraStream(null);
      return;
    }

    let pc: RTCPeerConnection | null = null;
    let callId: string | null = null;
    let mainAssigned = false;

    const startViewerConnection = async () => {
      console.log("Viewer initiating connection...");
      pc = new RTCPeerConnection(ICE_SERVERS);
      
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        console.log("Viewer received track:", event.track.kind, "Stream ID:", stream.id);
        
        if (event.track.kind === 'audio') {
           setRemoteCameraStream(stream);
        } else {
           if (!mainAssigned) {
              setRemoteMainStream(stream);
              mainAssigned = true;
           } else {
              setRemoteCameraStream(stream);
           }
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State:", pc?.iceConnectionState);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && callId) {
          addDoc(collection(db, 'calls', callId, 'answerCandidates'), event.candidate.toJSON());
        }
      };

      // 1. Create call document
      const docRef = await addDoc(collection(db, 'calls'), {
        createdAt: serverTimestamp(),
        viewerId: Math.random().toString(36).substring(7)
      });
      callId = docRef.id;

      // 2. Listen for offer
      onSnapshot(doc(db, 'calls', callId), async (snapshot) => {
        const data = snapshot.data();
        if (pc && pc.signalingState !== "closed" && !pc.currentRemoteDescription && data?.offer) {
          console.log("Viewer: Received offer from admin");
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          await updateDoc(doc(db, 'calls', callId!), {
            answer: { type: answer?.type, sdp: answer?.sdp }
          });
        }
      });

      // 3. Listen for admin candidates
      onSnapshot(collection(db, 'calls', callId, 'offerCandidates'), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added' && pc && pc.signalingState !== "closed") {
            pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        });
      });
    };

    startViewerConnection();

    return () => {
      if (pc) pc.close();
    };
  }, [isAdmin, streamData?.isActive]);

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
          <div id="viewer-placeholder" className="absolute inset-0 flex flex-col items-center justify-center bg-black">
            {streamData?.isActive ? (
              remoteMainStream ? (
                <video 
                  id="viewer-remote-video"
                  ref={viewerMainVideoRef} 
                  autoPlay 
                  playsInline 
                  className="w-full h-full object-contain" 
                />
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-20 h-20 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
                  <div className="text-center">
                    <span className="text-emerald-500 font-mono text-[10px] tracking-[0.2em] font-bold uppercase animate-pulse block mb-2">
                       Sincronizando con el servidor...
                    </span>
                    <button 
                      onClick={() => window.location.reload()}
                      className="text-zinc-500 hover:text-white text-[8px] uppercase tracking-widest font-bold underline transition-colors"
                    >
                      ¿Demasiado tiempo? Reintentar ahora
                    </button>
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
