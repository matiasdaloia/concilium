import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float, MeshTransmissionMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { colors } from '../styles/tokens';

function OrbitingSphere({
  color,
  radius,
  speed,
  offset,
}: {
  color: string;
  radius: number;
  speed: number;
  offset: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const particlesRef = useRef<THREE.Points>(null);

  const particlePositions = useMemo(() => {
    return new Float32Array(30); // 10 particles * 3
  }, []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime() * speed + offset;
    ref.current.position.x = Math.cos(t) * radius;
    ref.current.position.z = Math.sin(t) * radius;
    ref.current.position.y = Math.sin(t * 0.5) * 0.3;

    // Particles traveling toward center
    if (particlesRef.current) {
      const positions = particlesRef.current.geometry.attributes.position;
      if (positions) {
        for (let i = 0; i < 10; i++) {
          const progress = ((clock.getElapsedTime() * 0.5 + i * 0.1) % 1);
          const arr = positions.array as Float32Array;
          arr[i * 3] = ref.current.position.x * (1 - progress);
          arr[i * 3 + 1] = ref.current.position.y * (1 - progress);
          arr[i * 3 + 2] = ref.current.position.z * (1 - progress);
        }
        positions.needsUpdate = true;
      }
    }
  });

  return (
    <>
      <mesh ref={ref}>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      <points ref={particlesRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[particlePositions, 3]}
          />
        </bufferGeometry>
        <pointsMaterial color={color} size={0.03} transparent opacity={0.6} sizeAttenuation />
      </points>
    </>
  );
}

function CentralOrb() {
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (glowRef.current) {
      const scale = 1 + Math.sin(clock.getElapsedTime() * 0.5) * 0.05;
      glowRef.current.scale.setScalar(scale);
    }
  });

  return (
    <Float speed={1} rotationIntensity={0.2} floatIntensity={0.3}>
      <group>
        <mesh>
          <sphereGeometry args={[0.5, 32, 32]} />
          <MeshTransmissionMaterial
            backside
            thickness={0.5}
            chromaticAberration={0.2}
            anisotropy={0.1}
            distortion={0.1}
            distortionScale={0.2}
            temporalDistortion={0.1}
            color={colors.greenPrimary}
            transmission={0.95}
            roughness={0.1}
          />
        </mesh>
        <mesh ref={glowRef}>
          <sphereGeometry args={[0.55, 32, 32]} />
          <meshBasicMaterial color={colors.greenPrimary} transparent opacity={0.08} />
        </mesh>
      </group>
    </Float>
  );
}

function MouseParallax() {
  const { camera } = useThree();
  const mouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth - 0.5) * 0.5;
      mouse.current.y = (e.clientY / window.innerHeight - 0.5) * 0.5;
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useFrame(() => {
    camera.position.x += (mouse.current.x - camera.position.x) * 0.02;
    camera.position.y += (-mouse.current.y - camera.position.y) * 0.02;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function Scene() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[5, 5, 5]} intensity={0.5} />
      <pointLight position={[-5, -5, -5]} intensity={0.2} color={colors.greenPrimary} />

      <CentralOrb />

      <OrbitingSphere color={colors.providerOpencode} radius={1.2} speed={0.4} offset={0} />
      <OrbitingSphere color={colors.providerCodex} radius={1.4} speed={0.3} offset={Math.PI * 0.66} />
      <OrbitingSphere color={colors.providerClaude} radius={1.1} speed={0.35} offset={Math.PI * 1.33} />

      <MouseParallax />
    </>
  );
}

export default function CouncilOrb() {
  return (
    <div style={{ width: '100%', height: '100%', minHeight: '300px' }}>
      <Canvas
        camera={{ position: [0, 0, 3.5], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Scene />
      </Canvas>
    </div>
  );
}
