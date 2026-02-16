export default function TitleBar() {
  return (
    <div
      className="flex items-center justify-between px-6 h-10 shrink-0 select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    ></div>
  );
}
