/**
 * One stylesheet for every surface. Every selector carries the `dap-` prefix
 * (enforced by tests/client-styles.test.ts) so nothing leaks into the host
 * app; colours come from the harness `--dsw-alias-*` tokens with dark
 * fallbacks, and state is never carried by colour alone.
 *
 * @module dsh-account-pool/client/styles
 */

export const PAGE_CSS_ID = 'dsh-account-pool'

export const PAGE_CSS = `
.dap-page { max-width: 880px; padding: 0 4px 32px; display: flex; flex-direction: column; gap: 20px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }
.dap-page * { box-sizing: border-box; }
.dap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dap-title { margin: 0 0 4px; font-size: 20px; font-weight: 600; line-height: 1.25; }
.dap-sub { margin: 0; line-height: 1.5; color: var(--dsw-alias-label-secondary, #b9b9b9); max-width: 64ch; }
.dap-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8c8c8c); }
.dap-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dap-banner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 10px); border: 0.5px solid var(--dsw-alias-border-l2, #494949); background: var(--dsw-alias-bg-layer-1, #232323); line-height: 1.5; }
.dap-bannerWarn { border-color: var(--dsw-alias-state-warn-primary, #ffb454); }
.dap-bannerError { border-color: var(--dsw-alias-state-error-primary, #ff6b6b); }

.dap-tabs { display: flex; gap: 4px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); }
.dap-tab { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #b9b9b9); font-size: 13px; cursor: pointer; }
.dap-tab:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }
.dap-tabActive { color: var(--dsw-alias-label-primary, #e6e6e6); border-bottom-color: var(--dsw-alias-brand-primary, #4d6bfe); }

.dap-section { display: flex; flex-direction: column; gap: 10px; }
.dap-sectionHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dap-sectionTitle { margin: 0; font-size: 14px; font-weight: 600; }
.dap-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dap-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.dap-btn { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; font-size: 12.5px; border-radius: var(--dsw-radius-sm, 8px); border: 0.5px solid var(--dsw-alias-border-l2, #494949); background: var(--dsw-alias-bg-layer-1, #232323); color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; white-space: nowrap; }
.dap-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #2e2e2e); }
.dap-btn:disabled { opacity: .45; cursor: default; }
.dap-btn:focus-visible, .dap-tab:focus-visible, .dap-input:focus-visible, .dap-check:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.dap-btnPrimary { border-color: var(--dsw-alias-label-secondary, #b9b9b9); font-weight: 600; }
.dap-btnPrimary:disabled { border-color: var(--dsw-alias-border-l2, #494949); font-weight: 400; }
.dap-btnText { height: 26px; padding: 0 6px; border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #b9b9b9); font-size: 12px; }
.dap-btnDanger { height: 26px; padding: 0 6px; border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; }

.dap-input { height: 30px; width: 100%; padding: 0 9px; font-size: 13px; border-radius: var(--dsw-radius-sm, 8px); border: 0.5px solid var(--dsw-alias-border-l2, #494949); background: var(--dsw-alias-bg-layer-2, #1b1b1b); color: var(--dsw-alias-label-primary, #e6e6e6); }
.dap-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dap-inputNarrow { width: 88px; }
.dap-field { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 10px; align-items: center; }
.dap-fieldLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, #b9b9b9); }
.dap-check { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dap-srOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.dap-account { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 12px); border: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); background: var(--dsw-alias-bg-layer-1, #232323); }
.dap-accountServing { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dap-accountHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dap-accountName { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dap-accountBody { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); }

.dap-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.dap-badge { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap; color: var(--dsw-alias-label-secondary, #b9b9b9); background: var(--dsw-alias-bg-layer-2, #1b1b1b); }
.dap-badgeOk { color: var(--dsw-alias-state-success-primary, #3ddc97); }
.dap-badgeWarn { color: var(--dsw-alias-state-warn-primary, #ffb454); }
.dap-badgeBad { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dap-badgeBrand { color: var(--dsw-alias-brand-primary, #4d6bfe); }

.dap-quotas { display: flex; flex-direction: column; gap: 6px; }
.dap-quota { display: grid; grid-template-columns: 56px minmax(0, 1fr) 44px minmax(0, 96px); gap: 8px; align-items: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.dap-quotaLabel { color: var(--dsw-alias-label-secondary, #b9b9b9); }
.dap-quotaReset { color: var(--dsw-alias-label-tertiary, #8c8c8c); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dap-bar { position: relative; height: 5px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-border-l1, #3a3a3a); }
.dap-barFill { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary, #3ddc97); }
.dap-barWarn { background: var(--dsw-alias-state-warn-primary, #ffb454); }
.dap-barLimit { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dap-barNone { background: transparent; }

.dap-stats { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary, #b9b9b9); font-variant-numeric: tabular-nums; }
.dap-stats strong { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; }

.dap-modelList { display: flex; flex-direction: column; max-height: 280px; overflow-y: auto; border-radius: var(--dsw-radius-md, 10px); border: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); }
.dap-modelRow { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 10px; cursor: pointer; }
.dap-modelRow:hover { background: var(--dsw-alias-interactive-bg-hover, #2e2e2e); }
.dap-rule { display: grid; grid-template-columns: minmax(0, 1fr) 160px auto; gap: 8px; align-items: center; }

.dap-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); }
.dap-ok { color: var(--dsw-alias-state-success-primary, #3ddc97); }
.dap-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); }

.dap-card { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 8px 10px; border-radius: var(--dsw-radius-md, 10px); border: 0.5px solid var(--dsw-alias-border-l1, #3a3a3a); background: var(--dsw-alias-bg-layer-1, #232323); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; text-align: left; cursor: pointer; }
.dap-card:hover { background: var(--dsw-alias-interactive-bg-hover, #2e2e2e); }
.dap-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.dap-cardHead { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.dap-cardSub { color: var(--dsw-alias-label-tertiary, #8c8c8c); }

.dap-panel { display: flex; flex-direction: column; gap: 16px; height: 100%; overflow-y: auto; padding: 16px 20px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }
.dap-panel * { box-sizing: border-box; }
.dap-provider { display: flex; flex-direction: column; gap: 8px; }

@media (max-width: 640px) {
  .dap-field { grid-template-columns: 1fr; }
  .dap-quota { grid-template-columns: 48px minmax(0, 1fr) 40px; }
  .dap-quotaReset { display: none; }
  .dap-rule { grid-template-columns: 1fr; }
}
`
