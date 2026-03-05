"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ── MediaPipe CDN ────────────────────────────────────────────────────────────
const MEDIAPIPE_HANDS_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js";
const MEDIAPIPE_CAMERA_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js";

// ── Constants ────────────────────────────────────────────────────────────────
const DEADZONE = 0.08;
const SMOOTHING = 0.25; // Exponential smoothing factor (lower = smoother)
const CALIBRATION_FRAMES = 15; // Frames to average for calibration origin

// ── Types for MediaPipe (loaded at runtime) ──────────────────────────────────
interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

interface HandsResults {
  multiHandLandmarks?: HandLandmark[][];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Load a script tag and resolve when it's ready */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Clamp a value between min and max */
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/** Deadzone curve matching existing flight controls */
function deadzoneCurve(v: number): number {
  const abs = Math.abs(v);
  if (abs < DEADZONE) return 0;
  const adjusted = (abs - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * adjusted * adjusted;
}

/** Count extended fingers (tip above PIP joint = extended) */
function countExtendedFingers(landmarks: HandLandmark[]): number {
  let count = 0;
  // Index: tip 8, pip 6
  if (landmarks[8].y < landmarks[6].y) count++;
  // Middle: tip 12, pip 10
  if (landmarks[12].y < landmarks[10].y) count++;
  // Ring: tip 16, pip 14
  if (landmarks[16].y < landmarks[14].y) count++;
  // Pinky: tip 20, pip 18
  if (landmarks[20].y < landmarks[18].y) count++;
  // Thumb: tip 4 vs ip 3 (use x distance for thumb since it extends sideways)
  if (landmarks[4].x < landmarks[3].x) count++; // left hand default
  return count;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export type GestureStatus = "idle" | "loading" | "active" | "error";

interface UseGestureControlsOptions {
  /** Ref that the hook writes normalised steer X into (-1 … 1) */
  mouseRef: React.MutableRefObject<{ x: number; y: number }>;
  /** Ref that the hook writes virtual key presses into */
  keysRef: React.MutableRefObject<Record<string, boolean>>;
  /** Whether gesture mode is currently enabled */
  enabled: boolean;
  /** Preferred hand: "left" or "right" (affects thumb extension check) */
  preferredHand?: "left" | "right";
}

export function useGestureControls({
  mouseRef,
  keysRef,
  enabled,
  preferredHand = "right",
}: UseGestureControlsOptions) {
  const [status, setStatus] = useState<GestureStatus>("idle");
  const [handDetected, setHandDetected] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const lastDetection = useRef(0);
  const lostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Calibration state
  const calibrationOrigin = useRef<{ x: number; y: number } | null>(null);
  const calibrationSamples = useRef<{ x: number; y: number }[]>([]);

  // Smoothed output values
  const smoothedX = useRef(0);
  const smoothedY = useRef(0);

  // Recalibrate: reset origin so next frames re-capture neutral position
  const recalibrate = useCallback(() => {
    calibrationOrigin.current = null;
    calibrationSamples.current = [];
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Tear down
      if (cameraRef.current) {
        cameraRef.current.stop();
        cameraRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject &&
          (videoRef.current.srcObject as MediaStream)
            .getTracks()
            .forEach((t) => t.stop());
        videoRef.current.remove();
        videoRef.current = null;
      }
      if (debugCanvasRef.current) {
        debugCanvasRef.current.remove();
        debugCanvasRef.current = null;
      }
      if (lostTimer.current) clearTimeout(lostTimer.current);
      calibrationOrigin.current = null;
      calibrationSamples.current = [];
      smoothedX.current = 0;
      smoothedY.current = 0;
      setHandDetected(false);
      setStatus("idle");
      return;
    }

    let cancelled = false;

    // Check for debug overlay flag
    const showDebug =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("gestureDebug");

    async function init() {
      setStatus("loading");

      try {
        // 1. Load MediaPipe scripts
        await loadScript(MEDIAPIPE_HANDS_CDN);
        await loadScript(MEDIAPIPE_CAMERA_CDN);
        if (cancelled) return;

        // 2. Create hidden video element for the webcam feed
        const video = document.createElement("video");
        video.setAttribute("autoplay", "");
        video.setAttribute("playsinline", "");
        video.style.position = "fixed";
        video.style.top = "-9999px";
        video.style.left = "-9999px";
        video.style.width = "1px";
        video.style.height = "1px";
        video.style.opacity = "0";
        video.style.pointerEvents = "none";
        document.body.appendChild(video);
        videoRef.current = video;

        // 2b. Create debug overlay canvas if ?gestureDebug is set
        if (showDebug) {
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 240;
          canvas.style.position = "fixed";
          canvas.style.bottom = "80px";
          canvas.style.left = "16px";
          canvas.style.zIndex = "9999";
          canvas.style.border = "2px solid rgba(255,255,255,0.3)";
          canvas.style.borderRadius = "4px";
          canvas.style.background = "rgba(0,0,0,0.6)";
          canvas.style.pointerEvents = "none";
          document.body.appendChild(canvas);
          debugCanvasRef.current = canvas;
        }

        // 3. Initialise Hands
        const Hands = (window as any).Hands;
        if (!Hands) throw new Error("MediaPipe Hands not loaded");

        const hands = new Hands({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.5,
        });

        hands.onResults((results: HandsResults) => {
          if (cancelled) return;

          // Draw debug overlay
          if (showDebug && debugCanvasRef.current) {
            const ctx = debugCanvasRef.current.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, 320, 240);
              if (
                results.multiHandLandmarks &&
                results.multiHandLandmarks.length > 0
              ) {
                const lm = results.multiHandLandmarks[0];
                for (const point of lm) {
                  ctx.beginPath();
                  ctx.arc(point.x * 320, point.y * 240, 3, 0, Math.PI * 2);
                  ctx.fillStyle = "#22c55e";
                  ctx.fill();
                }
                // Draw calibration origin
                if (calibrationOrigin.current) {
                  ctx.beginPath();
                  ctx.arc(
                    calibrationOrigin.current.x * 320,
                    calibrationOrigin.current.y * 240,
                    6,
                    0,
                    Math.PI * 2,
                  );
                  ctx.strokeStyle = "#eab308";
                  ctx.lineWidth = 2;
                  ctx.stroke();
                }
              }
            }
          }

          if (
            results.multiHandLandmarks &&
            results.multiHandLandmarks.length > 0
          ) {
            lastDetection.current = Date.now();
            setHandDetected(true);
            if (lostTimer.current) {
              clearTimeout(lostTimer.current);
              lostTimer.current = null;
            }

            const landmarks = results.multiHandLandmarks[0];

            // Wrist (landmark 0) gives overall hand position
            const wrist = landmarks[0];

            // ── Calibration ──────────────────────────────────────────────
            // First N frames: accumulate samples, then compute neutral origin
            if (!calibrationOrigin.current) {
              calibrationSamples.current.push({ x: wrist.x, y: wrist.y });
              if (
                calibrationSamples.current.length >= CALIBRATION_FRAMES
              ) {
                const avg = calibrationSamples.current.reduce(
                  (a, s) => ({ x: a.x + s.x, y: a.y + s.y }),
                  { x: 0, y: 0 },
                );
                calibrationOrigin.current = {
                  x: avg.x / CALIBRATION_FRAMES,
                  y: avg.y / CALIBRATION_FRAMES,
                };
                calibrationSamples.current = [];
              }
              // During calibration, output neutral
              mouseRef.current.x = 0;
              mouseRef.current.y = 0;
              return;
            }

            const origin = calibrationOrigin.current;

            // Map wrist position relative to calibration origin
            // MediaPipe returns mirrored image, so invert X
            const rawX = clamp(((1 - wrist.x) - (1 - origin.x)) * 3, -1, 1);
            const rawY = clamp((origin.y - wrist.y) * 3, -1, 1);

            // Apply deadzone curve
            const curvedX = deadzoneCurve(rawX);
            const curvedY = deadzoneCurve(rawY);

            // Exponential smoothing
            smoothedX.current += (curvedX - smoothedX.current) * SMOOTHING;
            smoothedY.current += (curvedY - smoothedY.current) * SMOOTHING;

            mouseRef.current.x = clamp(smoothedX.current, -1, 1);
            mouseRef.current.y = clamp(smoothedY.current, -1, 1);

            // ── Finger-based speed control ───────────────────────────────
            // Count extended fingers (thumb check direction depends on hand)
            let extendedFingers = 0;
            // Non-thumb fingers: tip above PIP = extended
            if (landmarks[8].y < landmarks[6].y) extendedFingers++;   // index
            if (landmarks[12].y < landmarks[10].y) extendedFingers++; // middle
            if (landmarks[16].y < landmarks[14].y) extendedFingers++; // ring
            if (landmarks[20].y < landmarks[18].y) extendedFingers++; // pinky
            // Thumb: extends outward (X direction depends on hand)
            if (preferredHand === "right") {
              if (landmarks[4].x > landmarks[3].x) extendedFingers++;
            } else {
              if (landmarks[4].x < landmarks[3].x) extendedFingers++;
            }

            // 3+ fingers extended → boost, 1 finger → slow, 2 → normal
            keysRef.current["ShiftLeft"] = extendedFingers >= 3;
            keysRef.current["AltLeft"] = extendedFingers === 1;
          } else {
            // No hand detected — start lost timer
            setHandDetected(false);
            if (!lostTimer.current) {
              lostTimer.current = setTimeout(() => {
                if (cancelled) return;
                // Reset to neutral after 1s of no detection
                mouseRef.current.x = 0;
                mouseRef.current.y = 0;
                smoothedX.current = 0;
                smoothedY.current = 0;
                keysRef.current["ShiftLeft"] = false;
                keysRef.current["AltLeft"] = false;
                lostTimer.current = null;
              }, 1000);
            }
          }
        });

        handsRef.current = hands;

        // 4. Check for webcam availability before starting
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("getUserMedia not supported");
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasCamera = devices.some((d) => d.kind === "videoinput");
        if (!hasCamera) {
          throw new Error("No camera found");
        }
        if (cancelled) return;

        // 5. Start camera feed
        const Camera = (window as any).Camera;
        if (!Camera) throw new Error("MediaPipe Camera not loaded");

        const cam = new Camera(video, {
          onFrame: async () => {
            if (handsRef.current && videoRef.current) {
              await handsRef.current.send({ image: videoRef.current });
            }
          },
          width: 320,
          height: 240,
        });

        cameraRef.current = cam;
        try {
          await cam.start();
        } catch (camErr) {
          throw new Error("Camera access denied or unavailable");
        }
        if (cancelled) return;

        setStatus("active");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[GestureControls]", err);
        if (!cancelled) setStatus("error");
      }
    }

    init();

    return () => {
      cancelled = true;
      if (cameraRef.current) {
        cameraRef.current.stop();
        cameraRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject &&
          (videoRef.current.srcObject as MediaStream)
            .getTracks()
            .forEach((t) => t.stop());
        videoRef.current.remove();
        videoRef.current = null;
      }
      if (debugCanvasRef.current) {
        debugCanvasRef.current.remove();
        debugCanvasRef.current = null;
      }
      if (lostTimer.current) clearTimeout(lostTimer.current);
    };
  }, [enabled, mouseRef, keysRef, preferredHand]);

  return { status, handDetected, recalibrate };
}
