import { useCallback, useEffect, useState } from 'react';
import PatternWaves from './components/PatternWaves.jsx';
import { checkBackend, type BackendState } from './lib/api';
import {
  EMPTY_ANALYTICS,
  EMPTY_CRITERIA,
  EMPTY_FILES,
  recordInto,
  type AnalyticsState,
  type CriteriaState,
  type DocFiles,
} from './lib/sim';
import { VIEWS, type View } from './lib/view';
import Analytics from './views/Analytics';
import Generator from './views/Generator';
import Grading from './views/Grading';
import Home from './views/Home';
import Rubrics from './views/Rubrics';

const NAV: { key: View; label: string; icon: string }[] = [
  {
    key: 'home',
    label: 'Home',
    icon: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22 V12 h6 v10',
  },
  {
    key: 'grading',
    label: 'Exam Grading',
    icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2 v6 h6 M16 13 H8 M16 17 H8',
  },
  {
    key: 'generator',
    label: 'Generate Exam',
    icon: 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z',
  },
  {
    key: 'rubrics',
    label: 'Rubric Studio',
    icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    icon: 'M18 20 V10 M12 20 V4 M6 20 v-6',
  },
];

export default function App() {
  const [view, setView] = useState<View>(() => {
    const h = window.location.hash.replace('#', '');
    return (VIEWS as string[]).includes(h) ? (h as View) : 'home';
  });
  const [files, setFiles] = useState<DocFiles>(EMPTY_FILES);
  const [strict, setStrict] = useState(false);
  const [criteria, setCriteria] = useState<CriteriaState>(EMPTY_CRITERIA);
  const [modelOverride, setModelOverride] = useState('');
  const [live, setLive] = useState(true);
  const [backend, setBackend] = useState<BackendState>({ ok: false, model: 'moonshotai/kimi-k3', hasKey: false });
  const [demoRequest, setDemoRequest] = useState(0);
  const [analytics, setAnalytics] = useState<AnalyticsState>(EMPTY_ANALYTICS);
  const [graderNotice, setGraderNotice] = useState<{ id: number; msg: string } | null>(null);

  useEffect(() => {
    checkBackend().then(setBackend).catch(() => undefined);
  }, []);

  const navigate = useCallback((v: View) => {
    setView(v);
    window.history.replaceState(null, '', `#${v}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace('#', '');
      if ((VIEWS as string[]).includes(h)) setView(h as View);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const toggleCriterion = useCallback((k: string) => {
    setCriteria(prev => ({ ...prev, [k]: !prev[k] }));
  }, []);

  const handleRecord = useCallback((awarded: number, total: number, impact: Record<string, number>) => {
    setAnalytics(prev => recordInto(prev, awarded, total, impact));
  }, []);

  const handleSendToGrader = useCallback((paper: File, key: File) => {
    setFiles(prev => ({ ...prev, paper, key }));
    setGraderNotice({ id: Date.now(), msg: '✓ Generated paper & key loaded into the upload bay — now add the student sheet and run evaluation.' });
    navigate('grading');
  }, [navigate]);

  return (
    <>
      {view === 'home' && (
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
          <PatternWaves
            preset="silk"
            color="#81c784"
            backgroundColor="transparent"
            spacing={13}
            opacity={0.55}
            fade="edges"
            fadeSize={0.5}
            interactive
            cursorSize={50}
            cursorStrength={0.6}
          />
        </div>
      )}

      <div className="relative z-[1] mx-auto max-w-[1180px] px-4 pt-6 pb-[72px] md:px-5 md:pt-7">
        <nav
          aria-label="Main Navigation"
          className="sticky top-3.5 z-[90] mx-auto mb-7 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full border border-white/10 bg-black/45 p-2 shadow-[0_8px_24px_rgba(0,0,0,.4)] backdrop-blur-md"
        >
          <button
            type="button"
            onClick={() => navigate('home')}
            className="flex flex-none cursor-pointer items-center gap-2.5 border-none bg-transparent py-1 pr-2 pl-1 text-left text-white"
            aria-label="WeHelpTeachers home"
          >
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-pine to-[#3b7a53] text-sm font-extrabold text-[#0f1a13]"
            >
              WH
            </span>
            <span className="hidden text-[15px] font-bold tracking-tight whitespace-nowrap lg:block">WeHelpTeachers</span>
          </button>
          <span aria-hidden="true" className="h-6 w-px flex-none bg-white/10" />
          <div role="tablist" className="flex items-center gap-1">
            {NAV.map(t => (
              <button
                key={t.key}
                role="tab"
                aria-selected={view === t.key}
                type="button"
                onClick={() => navigate(t.key)}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-full border border-transparent px-3.5 py-2 text-[13.5px] font-semibold whitespace-nowrap transition ${
                  view === t.key ? 'bg-white/10 text-white' : 'bg-transparent text-white/45 hover:bg-white/5 hover:text-white'
                }`}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d={t.icon} />
                </svg>
                <span className="hidden md:block">{t.label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => navigate('grading')}
            className="flex-none cursor-pointer rounded-full border-none bg-white px-4 py-2 text-[13px] font-bold whitespace-nowrap text-black transition hover:brightness-90"
          >
            Start grading
          </button>
        </nav>

        <main>
          {view === 'home' && (
            <Home
              onNavigate={navigate}
              onTryDemo={() => {
                navigate('grading');
                setDemoRequest(n => n + 1);
              }}
              backendModel={backend.model}
              hasKey={backend.ok ? backend.hasKey : null}
            />
          )}
          {view === 'grading' && (
            <Grading
              files={files}
              setFiles={setFiles}
              strict={strict}
              setStrict={setStrict}
              criteria={criteria}
              toggleCriterion={toggleCriterion}
              modelOverride={modelOverride}
              setModelOverride={setModelOverride}
              live={live}
              setLive={setLive}
              backend={backend}
              demoRequest={demoRequest}
              notice={graderNotice}
              onRecord={handleRecord}
            />
          )}
          {view === 'generator' && <Generator modelOverride={modelOverride} onSendToGrader={handleSendToGrader} />}
          {view === 'rubrics' && <Rubrics />}
          {view === 'analytics' && <Analytics a={analytics} onReset={() => setAnalytics(EMPTY_ANALYTICS)} />}
        </main>

        <footer className="mt-8 border-t border-white/10 pt-4 text-center text-xs text-white/45">
          WeHelpTeachers — offline demo runs fully in your browser. With <b>live AI grading</b> on, documents are sent
          to your own deployment&apos;s <code>/api</code> (extract → grade) and on to NVIDIA&apos;s API. API keys stay
          on the server and are never hardcoded.
        </footer>
      </div>
    </>
  );
}
