// theme — semantic theme-role resolution for the Code intel panel.
//
// A resolved color: OpenTUI accepts an RGBA instance or a hex string. Theme
// tokens are RGBA (their leaves are `{ toString() }`), the fallbacks hex.
//
// Pure: no Solid, no node builtins, so this is a legal sibling module of the
// `./tui` entrypoint (see tui.tsx header).

export type Color = { readonly toString: () => string } | string;

export type Token = { readonly toString: () => string };

// The slice of the theme tree this plugin reads. The runtime token values are
// RGBA objects, not strings, so leaves are typed as Token (Color-acceptable).
export type ThemeTokens = {
  text?: {
    base?: Token;
    muted?: Token;
    subtle?: Token;
    feedback?: {
      success?: { base?: Token };
      warning?: { base?: Token };
      error?: { base?: Token };
      info?: { base?: Token };
    };
  };
};

export type Palette = {
  text: Color;
  muted: Color;
  subtle: Color;
  ok: Color;
  warn: Color;
  bad: Color;
  info: Color;
};

// Semantic theme roles resolved from the active theme (context.theme). Falls
// back to the built-in OpenCode dark palette only if a token is missing, so a
// missing key degrades instead of throwing inside a render.
const FALLBACK = {
  text: "#cdd6f4",
  muted: "#6c7086",
  subtle: "#a6adc8",
  ok: "#a6e3a1",
  warn: "#f9e2af",
  bad: "#f38ba8",
  info: "#94e2d5",
} as const;

export function palette(theme: ThemeTokens | undefined): Palette {
  try {
    const text = theme?.text;
    return {
      text: text?.base ?? FALLBACK.text,
      muted: text?.muted ?? FALLBACK.muted,
      subtle: text?.subtle ?? FALLBACK.subtle,
      ok: text?.feedback?.success?.base ?? FALLBACK.ok,
      warn: text?.feedback?.warning?.base ?? FALLBACK.warn,
      bad: text?.feedback?.error?.base ?? FALLBACK.bad,
      info: text?.feedback?.info?.base ?? FALLBACK.info,
    };
  } catch {
    return { ...FALLBACK };
  }
}
