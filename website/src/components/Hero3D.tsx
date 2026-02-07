import { motion } from "motion/react";
// @ts-ignore
import logoUrl from "../assets/concilium-logo.png?url";

export default function Hero3D() {
  return (
    <div className="relative w-full h-[400px] md:h-[600px] flex items-center justify-center pointer-events-none z-0 overflow-visible">
      {/* Background Glow Layer */}
      <motion.div 
        className="absolute w-[120%] h-[120%] rounded-full bg-green-500/10 blur-[100px]"
        animate={{
          scale: [1, 1.1, 1],
          opacity: [0.1, 0.2, 0.1],
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />

      {/* Floating Logo Layer */}
      <motion.div
        className="relative z-10 w-full h-full flex items-center justify-center"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 1.5, ease: "easeOut" }}
      >
        <motion.img
          src={logoUrl}
          alt="Concilium Emblem"
          className="w-[80%] h-[80%] object-contain drop-shadow-[0_0_40px_rgba(34,197,94,0.2)]"
          animate={{
            y: [-15, 15, -15],
            rotate: [-2, 2, -2],
          }}
          transition={{
            duration: 6,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        
        {/* Inner Pulse Ring */}
        <motion.div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] rounded-full border border-green-500/10"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1.2, opacity: 0 }}
            transition={{
                duration: 3,
                repeat: Infinity,
                ease: "easeOut",
                delay: 0.5
            }}
        />
      </motion.div>
    </div>
  );
}
