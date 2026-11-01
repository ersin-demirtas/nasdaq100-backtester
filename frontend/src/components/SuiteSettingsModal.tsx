import React from 'react';
import { RotateCcw, Sliders, X } from 'lucide-react';
import type { UniversalSuiteSettings } from '../types';

export const DEFAULT_SUITE_SETTINGS: UniversalSuiteSettings = {
  show_fvg: true,
  show_ma: true,
  show_vwap: true,
  show_aem: true,
  show_mtf: true,

  fvg_tf: '240',
  fvg_threshold_pct: 0,
  fvg_auto: false,
  fvg_unmitigated_levels: 0,
  fvg_mitigation_levels: false,
  fvg_extend: 20,
  fvg_auto_extend: true,
  fvg_dynamic: false,

  ma_short_len: 9,
  ma_long_len: 21,

  vwap_anchor: 'Session',
  vwap_calc_mode: 'Standard Deviation',
  vwap_show_band_1: true,
  vwap_mult_1: 1.0,
  vwap_show_band_2: false,
  vwap_mult_2: 2.0,
  vwap_show_band_3: false,
  vwap_mult_3: 3.0,

  aem_round_to: 5,
  aem_iv_mult: 1.0,
};

interface Props {
  open: boolean;
  onClose: () => void;
  settings: UniversalSuiteSettings;
  onChange: (next: UniversalSuiteSettings) => void;
}

export const SuiteSettingsModal: React.FC<Props> = ({ open, onClose, settings, onChange }) => {
  if (!open) return null;

  const set = <K extends keyof UniversalSuiteSettings>(key: K, val: UniversalSuiteSettings[K]) => {
    onChange({ ...settings, [key]: val });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#181c27] border border-slate-700/80 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden text-xs">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-[#131722]">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#2962FF]" />
            <h2 className="text-sm font-bold text-white">Multi-Strategy Universal Suite — Indicator Inputs</h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onChange(DEFAULT_SUITE_SETTINGS)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" /> Defaults
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5 max-h-[78vh] overflow-y-auto">
          {/* Master Toggles */}
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              --- Indicator Master Toggles ---
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 bg-[#131722] p-3 rounded-xl border border-slate-800">
              {[
                { k: 'show_fvg', label: 'Enable Fair Value Gap' },
                { k: 'show_ma', label: 'Enable MA Cross' },
                { k: 'show_vwap', label: 'Enable VWAP' },
                { k: 'show_aem', label: 'Enable 0DTE AEM' },
                { k: 'show_mtf', label: 'Enable MTF Candles (Right)' },
              ].map((item) => (
                <label key={item.k} className="flex items-center gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(settings[item.k as keyof UniversalSuiteSettings])}
                    onChange={(e) => set(item.k as keyof UniversalSuiteSettings, e.target.checked as never)}
                    className="accent-[#2962FF]"
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </div>

          {/* 1. Fair Value Gap [LuxAlgo] */}
          <div className="space-y-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#089981]">
              1. Fair Value Gap [LuxAlgo] Settings
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 bg-[#131722] p-3.5 rounded-xl border border-slate-800">
              <div>
                <label className="text-slate-400 block mb-1">FVG Timeframe</label>
                <select
                  value={settings.fvg_tf}
                  onChange={(e) => set('fvg_tf', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white"
                >
                  <option value="Chart">Chart (Current TF)</option>
                  <option value="3">3 Minutes</option>
                  <option value="5">5 Minutes</option>
                  <option value="15">15 Minutes</option>
                  <option value="60">1 Hour (60)</option>
                  <option value="240">4 Hours (240)</option>
                  <option value="D">1 Day (D)</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Threshold %</label>
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  disabled={settings.fvg_auto}
                  value={settings.fvg_threshold_pct}
                  onChange={(e) => set('fvg_threshold_pct', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white disabled:opacity-40"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Extend (Bars)</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={settings.fvg_extend}
                  onChange={(e) => set('fvg_extend', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white"
                />
              </div>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.fvg_auto}
                  onChange={(e) => set('fvg_auto', e.target.checked)}
                  className="accent-[#089981]"
                />
                Auto Threshold
              </label>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.fvg_auto_extend}
                  onChange={(e) => set('fvg_auto_extend', e.target.checked)}
                  className="accent-[#089981]"
                />
                Stretch Unmitigated to Right
              </label>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.fvg_mitigation_levels}
                  onChange={(e) => set('fvg_mitigation_levels', e.target.checked)}
                  className="accent-[#089981]"
                />
                Mitigation Dashed Levels
              </label>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.fvg_dynamic}
                  onChange={(e) => set('fvg_dynamic', e.target.checked)}
                  className="accent-[#089981]"
                />
                Dynamic Rolling Mode
              </label>

              <div>
                <label className="text-slate-400 block mb-1">Unmitigated Levels</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={settings.fvg_unmitigated_levels}
                  onChange={(e) => set('fvg_unmitigated_levels', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-white"
                />
              </div>
            </div>
          </div>

          {/* 2. MA Cross */}
          <div className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#FF6D00]">2. MA Cross Settings</div>
            <div className="grid grid-cols-2 gap-3 bg-[#131722] p-3.5 rounded-xl border border-slate-800">
              <div>
                <label className="text-slate-400 block mb-1">Short SMA Length (#FF6D00)</label>
                <input
                  type="number"
                  min={1}
                  value={settings.ma_short_len}
                  onChange={(e) => set('ma_short_len', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Long SMA Length (#43A047)</label>
                <input
                  type="number"
                  min={2}
                  value={settings.ma_long_len}
                  onChange={(e) => set('ma_long_len', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white"
                />
              </div>
            </div>
          </div>

          {/* 3. VWAP & Bands */}
          <div className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#2962FF]">3. VWAP & Bands Settings</div>
            <div className="grid grid-cols-2 gap-3 bg-[#131722] p-3.5 rounded-xl border border-slate-800">
              <div>
                <label className="text-slate-400 block mb-1">Anchor Period</label>
                <select
                  value={settings.vwap_anchor}
                  onChange={(e) => set('vwap_anchor', e.target.value as UniversalSuiteSettings['vwap_anchor'])}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white"
                >
                  <option value="Session">Session (Daily)</option>
                  <option value="Week">Week</option>
                  <option value="Month">Month</option>
                  <option value="Quarter">Quarter</option>
                  <option value="Year">Year</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Bands Calculation Mode</label>
                <select
                  value={settings.vwap_calc_mode}
                  onChange={(e) => set('vwap_calc_mode', e.target.value as UniversalSuiteSettings['vwap_calc_mode'])}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white"
                >
                  <option value="Standard Deviation">Standard Deviation</option>
                  <option value="Percentage">Percentage</option>
                </select>
              </div>

              {([1, 2, 3] as const).map((idx) => {
                const showKey = `vwap_show_band_${idx}` as const;
                const multKey = `vwap_mult_${idx}` as const;
                return (
                  <div key={idx} className="col-span-2 flex items-center justify-between border-t border-slate-800/70 pt-2">
                    <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings[showKey]}
                        onChange={(e) => set(showKey, e.target.checked)}
                        className="accent-[#2962FF]"
                      />
                      Show VWAP Band #{idx}
                    </label>
                    <input
                      type="number"
                      step={0.5}
                      min={0.1}
                      value={settings[multKey]}
                      onChange={(e) => set(multKey, Number(e.target.value))}
                      className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-right text-white"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. 0DTE AEM */}
          <div className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-teal-400">
              4. 0DTE Anchored Expected Move [SyntaxGeek]
            </div>
            <div className="grid grid-cols-2 gap-3 bg-[#131722] p-3.5 rounded-xl border border-slate-800">
              <div>
                <label className="text-slate-400 block mb-1">Center Strike Round To Nearest</label>
                <input
                  type="number"
                  min={1}
                  value={settings.aem_round_to}
                  onChange={(e) => set('aem_round_to', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Implied Vol / Straddle Scale</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.3}
                  max={3.0}
                  value={settings.aem_iv_mult}
                  onChange={(e) => set('aem_iv_mult', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-white"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-800 bg-[#131722] flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded-lg bg-[#2962FF] hover:bg-blue-500 text-white font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
