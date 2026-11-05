import { FONT_FACE_CSS } from '../brand/fonts.generated.js';

/**
 * The sign-in page's whole stylesheet.
 *
 * Values here are measured off the live https://hedera.com/mcp-servers, because this page is the
 * second screen of that page's flow and has to look like it: pure black page, charcoal raised
 * surfaces, ultraviolet primary actions, Light headings at -0.02em, capsule buttons, a shadowless
 * flat treatment and one curve for all motion.
 *
 * Dark only, deliberately. There is no light scheme: users arrive here from a black page and a
 * light flash mid-OAuth would read as a different site.
 */
export const CONNECT_CSS = `
${FONT_FACE_CSS}

:root{
  color-scheme: dark;

  --black:#000;
  --charcoal:#11151D;
  --white:#FFF;
  --smoke:#9B9B9D;
  --ultraviolet:#8259EF;
  --ultraviolet-hover:#6F45E4;
  --ultraviolet-press:#5E36CC;
  --azure:#0031FF;
  --lilac:#B47AFF;

  --fill-subtle:rgba(255,255,255,.06);
  --fill-hover:rgba(255,255,255,.12);
  --hairline:rgba(255,255,255,.12);
  --hairline-strong:rgba(255,255,255,.22);

  --font:Montserrat,'Helvetica Neue',Helvetica,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;

  --ease:cubic-bezier(.2,0,.2,1);
  --fast:150ms;
  --base:220ms;
}

*,*::before,*::after{box-sizing:border-box}

body{
  margin:0;
  background:var(--black);
  color:var(--white);
  font-family:var(--font);
  font-weight:400;
  font-size:16px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
  display:flex;
  flex-direction:column;
  min-height:100vh;
}

/* The brand gradient runs ultraviolet to azure, in that direction, always. */
.rule{height:4px;background:linear-gradient(90deg,var(--ultraviolet) 0%,var(--azure) 100%);flex:none}

.masthead{
  display:flex;align-items:center;gap:16px;
  padding:20px 24px;border-bottom:1px solid var(--hairline);flex:none;
}
.brand{display:inline-flex;color:var(--white);text-decoration:none;border-radius:2px}
.brand svg{height:22px;width:auto;display:block}
.pill{
  font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;
  color:var(--white);background:rgba(130,89,239,.2);
  border:1px solid rgba(130,89,239,.6);border-radius:999px;padding:4px 12px;
}

.wrap{flex:1;display:flex;justify-content:center;padding:48px 24px 64px}
main{width:100%;max-width:560px}

.eyebrow{
  margin:0 0 16px;font-size:12px;font-weight:500;line-height:1.2;
  letter-spacing:.12em;text-transform:uppercase;color:var(--smoke);
}
h1{
  margin:0 0 16px;font-weight:300;font-size:40px;line-height:1.1;
  letter-spacing:-.02em;color:var(--white);
}
.lede{margin:0 0 20px;color:var(--smoke);font-size:16px;line-height:1.5}
/* Lilac is the brand's link colour on black. Underlined rather than colour-only, so the links are
   still findable for a reader who cannot separate lilac from grey. */
.lede a,
.panel a{
  color:var(--lilac);text-decoration:underline;
  text-underline-offset:2px;text-decoration-thickness:1px;
  transition:color var(--fast) var(--ease);
}
.lede a:hover,
.panel a:hover{color:var(--white)}

/* The one thing on this page a user must read before approving anything. Given its own surface
   rather than a coloured left border, which the brand does not use. */
.caution{
  margin:0 0 32px;padding:16px 20px;background:var(--charcoal);
  border:1px solid var(--hairline);border-radius:12px;
  font-size:14px;line-height:1.5;color:var(--smoke);
}
.caution b{display:block;color:var(--lilac);font-weight:500;margin-bottom:2px}

/* ---- Step tracker ---------------------------------------------------------------------- */
/* State is never carried by colour alone: the mark changes numeral -> checkmark, and the current
   step carries aria-current="step". */
.tracker{display:flex;gap:8px;margin:0 0 24px;padding:0;list-style:none}
.step{flex:1;display:flex;flex-direction:column;gap:8px;min-width:0}
.step-bar{height:2px;background:var(--fill-hover);border-radius:999px;transition:background var(--base) var(--ease)}
.step-row{display:flex;align-items:center;gap:8px;min-width:0}
.step-mark{
  flex:none;width:20px;height:20px;border-radius:50%;
  display:grid;place-items:center;
  font-size:11px;font-weight:500;line-height:1;
  color:var(--smoke);border:1px solid var(--hairline-strong);
  transition:color var(--fast) var(--ease),border-color var(--fast) var(--ease),background var(--fast) var(--ease);
}
/* Both marks ship in the DOM and CSS chooses between them, so the client never has to build or
   inject SVG. Every rule below is written at the same specificity (.step-mark + child class) so
   the swap is decided by source order, not by which selector happens to be heavier. */
.step-mark .mark-check{width:20px;height:20px;display:none}
.step-mark .mark-num{display:block}
.step[data-state="done"] .mark-num{display:none}
.step[data-state="done"] .mark-check{display:block}
.tracker[data-halted="true"] .mark-check{display:none}
.tracker[data-halted="true"] .mark-num{display:block}
.step-label{
  font-size:12px;color:var(--smoke);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;
  transition:color var(--fast) var(--ease);
}
.step[data-state="current"] .step-bar{background:var(--ultraviolet)}
.step[data-state="current"] .step-mark{color:var(--white);border-color:var(--ultraviolet);background:var(--ultraviolet)}
.step[data-state="current"] .step-label{color:var(--white)}
.step[data-state="done"] .step-bar{background:var(--ultraviolet)}
.step[data-state="done"] .step-mark{color:var(--ultraviolet);border-color:transparent;background:transparent}
.step[data-state="done"] .step-label{color:var(--smoke)}
.tracker[data-halted="true"] .step-bar{background:var(--fill-hover)}
.tracker[data-halted="true"] .step-mark{color:var(--smoke);background:transparent;border-color:var(--hairline-strong)}
.tracker[data-halted="true"] .step-label{color:var(--smoke)}

/* ---- Panel ----------------------------------------------------------------------------- */
.panel{
  background:var(--charcoal);border:1px solid var(--hairline);border-radius:16px;
  padding:32px;text-align:center;
}

.btn{
  font-family:inherit;font-size:14px;font-weight:500;line-height:1;
  display:inline-flex;align-items:center;justify-content:center;gap:10px;
  min-height:44px;padding:0 24px;border-radius:999px;cursor:pointer;
  border:1px solid transparent;
  transition:background var(--fast) var(--ease),border-color var(--fast) var(--ease),transform var(--fast) var(--ease);
}
.btn-primary{background:var(--ultraviolet);color:var(--white)}
.btn-primary:hover{background:var(--ultraviolet-hover)}
.btn-primary:active{background:var(--ultraviolet-press);transform:scale(.98)}
.btn-ghost{background:transparent;color:var(--white);border-color:var(--hairline-strong)}
.btn-ghost:hover{background:var(--fill-hover)}
.btn-ghost:active{transform:scale(.98)}
.btn img{width:20px;height:20px;border-radius:4px;flex:none}

.wallets{display:flex;flex-direction:column;gap:8px;margin-bottom:24px}
.wallets:empty{display:none}

.divider{
  display:flex;align-items:center;gap:12px;margin:0 0 24px;
  font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--smoke);
}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--hairline)}

/* The QR needs a white quiet zone to scan reliably, so this plate is the one white surface. */
.qr{
  width:220px;height:220px;margin:0 auto 20px;display:block;
  background:var(--white);border-radius:12px;padding:12px;
}

.uri{
  display:block;width:100%;margin:0;padding:12px 14px;
  background:var(--black);border:1px solid var(--hairline);border-radius:12px;
  font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--smoke);
  word-break:break-all;text-align:left;
  max-height:76px;overflow:auto;
}
.uri-row{display:flex;flex-direction:column;gap:8px;align-items:center}

.account{
  display:inline-block;margin:0 0 4px;padding:6px 14px;
  background:var(--black);border:1px solid var(--hairline);border-radius:999px;
  font-family:var(--mono);font-size:13px;color:var(--lilac);
}

.panel h2{margin:0 0 8px;font-weight:300;font-size:26px;line-height:1.15;letter-spacing:-.02em;color:var(--white)}
.panel p{margin:0;color:var(--smoke);font-size:14px}
.panel p + p{margin-top:12px}
.panel p + #open-wallet{margin-top:24px}

/* Semantic colour sits outside the brand palette on purpose, and is used only here.
   Scoped under .panel so it outweighs the .panel p rule, which would otherwise win on
   specificity. (No backticks in CSS comments here: this file is one big template literal.) */
.panel .error-text{color:#F0768F;font-size:14px;margin:0 0 8px;word-break:break-word}

.skeleton{height:220px;border-radius:12px;background:var(--fill-subtle);position:relative;overflow:hidden}
.skeleton::after{
  content:'';position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,var(--fill-hover),transparent);
  animation:sweep 1.4s var(--ease) infinite;
}
@keyframes sweep{to{transform:translateX(100%)}}

.status{
  margin:20px 0 0;text-align:center;font-size:14px;font-weight:500;color:var(--white);
  min-height:21px;
}
.status:empty{margin:0}

footer{
  flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;
  padding:24px;border-top:1px solid var(--hairline);
  font-size:12px;color:var(--smoke);
}
footer a{color:var(--white);text-decoration:none;border-bottom:1px solid var(--hairline-strong);padding-bottom:1px}
footer a:hover{border-bottom-color:var(--white)}
footer .legal{margin-left:auto;letter-spacing:.12em;text-transform:uppercase}

/* Ultraviolet on purpose: a different hue from the action colour, so focus reads as a system
   affordance rather than as a second button state. */
:focus-visible{outline:2px solid var(--ultraviolet);outline-offset:2px}

@media (max-width:560px){
  h1{font-size:32px}
  .wrap{padding:32px 16px 48px}
  .panel{padding:24px 20px}
  .masthead{padding:16px}
  .step-label{font-size:11px}
  footer .legal{margin-left:0;width:100%}
}

/* No bounce, no spring, and nothing that moves for a user who asked it not to. */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0ms !important;animation-iteration-count:1 !important;transition-duration:0ms !important}
}
`;
