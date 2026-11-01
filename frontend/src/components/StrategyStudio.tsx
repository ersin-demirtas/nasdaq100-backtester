import React, { useEffect, useState } from 'react';
import { CheckCircle2, Code2, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { StrategyInfo } from '../types';

interface Props {
  strategies: StrategyInfo[];
  selectedStrategyId: string;
  customTemplate: string;
  onStrategiesUpdated: (strategies: StrategyInfo[], selectId?: string) => void;
}

export const StrategyStudio: React.FC<Props> = ({
  strategies,
  selectedStrategyId,
  customTemplate,
  onStrategiesUpdated,
}) => {
  const current = strategies.find((s) => s.id === selectedStrategyId) || strategies[0];
  const [slug, setSlug] = useState('my_nas100_scalp');
  const [code, setCode] = useState(current?.code || customTemplate);
  const [isNewMode, setIsNewMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!isNewMode && current) {
      setCode(current.code || customTemplate);
      if (current.is_custom) {
        setSlug(current.id.replace(/^custom_/, ''));
      }
    }
  }, [current, isNewMode, customTemplate]);

  const startNewPlugin = () => {
    setIsNewMode(true);
    setSlug('my_nas100_scalp');
    setCode(customTemplate);
    setMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.saveCustomStrategy(slug, code);
      setIsNewMode(false);
      setMsg({ type: 'ok', text: `Validated & saved strategy plugin: ${res.strategy.name}` });
      onStrategiesUpdated(res.strategies, res.strategy.id);
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!current?.is_custom) return;
    try {
      const res = await api.deleteCustomStrategy(current.id);
      onStrategiesUpdated(res.strategies, res.strategies[0]?.id);
      setMsg({ type: 'ok', text: 'Deleted custom strategy.' });
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const editable = isNewMode || Boolean(current?.is_custom);

  return (
    <div className="bg-slate-900/85 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-full min-h-[560px]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-slate-950/80 border-b border-slate-800 text-xs">
        <div className="flex items-center gap-2.5">
          <Code2 className="w-4 h-4 text-cyan-400" />
          <span className="font-bold text-white">
            {isNewMode ? 'New Custom Python Strategy Plugin' : current?.name}
          </span>
          {!editable && (
            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono text-[10px]">
              Built-in Kernel (Read-Only — click "+ New Custom Plugin" to fork/author)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={startNewPlugin}
            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> New Custom Plugin
          </button>

          {editable && (
            <>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="plugin_slug"
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 font-mono text-white w-44"
              />
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1"
              >
                <Save className="w-3.5 h-3.5" /> {saving ? 'Validating...' : 'Validate & Save .py'}
              </button>
              {current?.is_custom && !isNewMode && (
                <button
                  onClick={handleDelete}
                  className="p-1.5 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                  title="Delete custom strategy"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {msg && (
        <div
          className={`px-4 py-2 text-xs font-mono flex items-center gap-2 border-b ${
            msg.type === 'ok'
              ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/50 border-rose-800/60 text-rose-300'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          {msg.text}
        </div>
      )}

      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        readOnly={!editable}
        spellCheck={false}
        className="flex-1 w-full bg-[#070b14] text-slate-200 font-mono text-xs leading-relaxed p-4 outline-none resize-none"
      />
    </div>
  );
};
