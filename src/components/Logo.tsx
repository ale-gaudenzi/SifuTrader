/**
 * SifuTrader brand mark. The image lives in `public/logo.jpg` (a 128px
 * downscale of `cambiare_idea.jpeg`); the favicons are generated from the same
 * source.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}logo.jpg`}
      width={size}
      height={size}
      alt=""
      className="rounded-md ring-1 ring-terminal-border"
    />
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <h1 className="text-[15px] font-bold tracking-tight">
        Sifu<span className="text-up">Trader</span>
      </h1>
    </div>
  );
}
