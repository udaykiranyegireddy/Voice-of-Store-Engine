import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BrainCircuit,
  CalendarDays,
  Check,
  ClipboardList,
  Download,
  Globe2,
  LayoutDashboard,
  LogOut,
  MapPin,
  MessageSquareText,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Store,
  X,
  Workflow,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Severity } from './data';
import AuthScreen, { type AuthMode } from './components/AuthScreen';
import { authRouteDecision } from './lib/authAccess';
import {
  restoreSupabaseSession,
  signInWithEmailPassword,
  signInWithGoogle,
  signOutFromSupabase,
  signUpWithEmailPassword,
} from './lib/authActions';
import { buildLiveCategorySignals, buildLiveTrend, findEmergingIssues, latestReportingPeriod, summarizeRegions, weeklyRateComparisonLabel } from './lib/analytics';
import {
  loadIncidentEvidenceForIncidents,
  loadIncidentEvidenceForPeriod,
  loadIncidentsByIds,
  loadIncidents,
  loadStoreWeeklyIssueRates,
  loadStoreMemberships,
  createIncident,
  attachIncidentEvidence,
  updateIncident,
  type CreatedIncidentResponse,
  type FeedbackDecision,
  type IncidentEvidence,
  type IncidentRecord,
  type IncidentStatus,
  type StoreMembership,
  type StoreWeeklyIssueRate,
} from './lib/incidentService';
import {
  loadDuplicateReviewVotes,
  saveDuplicateReviewVote,
  type DuplicateReviewDecision,
  type DuplicateReviewVote,
} from './lib/duplicateReviewService';
import { findLiveDuplicateMatch } from './lib/liveDuplicateDetection';
import {
  dataViewAfterAccountChange,
  initialDataView,
  loadLocalIncidentSnapshot,
  saveLocalIncident,
  updateLocalIncident,
  type IncidentDataView,
} from './lib/localIncidentStore';
import { supabase, supabaseConfigured } from './lib/supabase';

type SeverityFilter = 'All' | Severity;
type FeedbackAnalysis = FeedbackDecision & Partial<Pick<CreatedIncidentResponse, 'incident_id' | 'assigned_department' | 'created_at' | 'updated_at'>>;
type DataView = IncidentDataView;
type DisplayFeedback = {
  id: string;
  text: string;
  source: string;
  store: string;
  region: string;
  location: string;
  category: string;
  severity: string;
  status: string;
  received: string;
  assignedDepartment: string;
  recommendedAction: string;
  evidenceCount: number;
  requiresHumanVerification: boolean;
  humanVerifiedAt: string | null;
  incidentId?: string;
};

type RegionalReportingData = {
  rates: StoreWeeklyIssueRate[];
  incidents: IncidentRecord[];
  evidence: IncidentEvidence[];
};

type BenchmarkFeedbackRecord = {
  feedback_id: string;
  text: string;
  channel: string;
  created_at: string;
  store_id: string;
  store_name: string;
  location: string;
  region: string;
  week_index: number;
  category: string;
  issue_type_id: string;
  severity: Severity;
  actionable: boolean;
  owner_function: string;
  assigned_department: string;
};

type BenchmarkAlert = {
  week_start: string;
  store_id: string;
  store_name: string;
  region: string;
  issue_type_id: string;
  category: string;
  owner_function: string;
  severity: Severity;
  detector_score: number;
  current_rate_per_1000_footfall: number | null;
  rolling_mean_per_1000_footfall: number | null;
  ewma_baseline_per_1000_footfall: number | null;
  ewma_z_score: number | null;
  evidence_count: number;
  evidence_feedback_ids: string[];
  evidence: BenchmarkFeedbackRecord[];
  matches_public_incident_example: boolean;
};

type BenchmarkWeek = {
  week_index: number;
  week_start: string;
  week: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unclassified: number;
  total: number;
};

type BenchmarkBriefIssue = {
  category: string;
  issue_type_id: string;
  severity: Severity;
  owner_function: string;
  responsible_department: string;
  feedback_count: number;
  actionable_share: number;
  normalized_rate_per_1000_exposure: number | null;
  previous_feedback_count: number | null;
  previous_rate_per_1000_exposure: number | null;
  rate_store_coverage: number;
  rate_feedback_count: number;
  rate_denominator: number;
  previous_rate_denominator: number;
  rate_store_ids: string[];
  previous_rate_store_ids: string[];
  normalization_source: 'transactions' | 'footfall_proxy';
  trend: 'up' | 'down' | 'flat' | 'no_baseline';
  affected_stores: string[];
  emerging_flag_count: number;
  emerging_stores: string[];
  quotes: { feedback_id: string; text: string; source: string; store_name: string; location: string }[];
  recommended_action: string;
  recommended_investigation: string;
};

type BenchmarkEmergingIssue = {
  category: string;
  issue_type_id: string;
  responsible_department: string;
  flag_count: number;
  flagged_stores: string[];
  evidence_count: number;
  quotes: BenchmarkFeedbackRecord[];
};

type BenchmarkBrief = {
  region: string;
  week_index: number;
  week_start: string;
  week_end: string;
  previous_week_index: number | null;
  previous_week_available: boolean;
  previous_week_feedback_rows: number;
  available_regions: string[];
  available_weeks: { week_index: number; week_start: string }[];
  source_status: string;
  feedback_rows: number;
  expected_store_count: number;
  covered_store_count: number;
  normalization_source: 'transactions' | 'footfall_proxy';
  normalization_note: string;
  confirmed_deduplicated_reports: number;
  validation_precision: { actionable_precision: number; actionable_high_or_critical_precision: number; rows: number };
  issues: BenchmarkBriefIssue[];
  all_issues: BenchmarkBriefIssue[];
  emerging_issues: BenchmarkEmergingIssue[];
  empty_period_message: string | null;
};

type BenchmarkOverview = {
  source_label: string;
  summary: {
    feedback_records: number;
    prediction_records: number;
    public_training_labels: number;
    taxonomy_categories: number;
    stores: number;
    store_options: { store_id: string; store_name: string; region: string; location: string }[];
    regions: string[];
    weeks: number;
    first_week_start: string;
    last_week_start: string;
    emerging_flag_rows: number;
    valid_evidence_ids: number;
    channel_counts: Record<string, number>;
    critical_or_high_predictions: number;
    actionable_predictions: number;
    transaction_rows_loaded: number;
    transaction_weeks_loaded: number;
  };
  metrics: {
    holdout: {
      method: string;
      rows: number;
      issue_type_classes: number;
      issue_type_macro_f1: number;
      severity_weighted_f1: number;
      actionable_positive_f1: number;
      actionable_precision: number;
      actionable_high_or_critical_precision: number;
    };
    public_evaluator: {
      rows: number;
      classification_score: number;
      primary_score: number;
      lead_score: number;
      flags_in_scored_period: number;
      valid_flags: number;
      first_public_incident_flag_week: string | null;
      baseline_first_flag_week: string | null;
    };
  };
  trend: BenchmarkWeek[];
  categories: { category: string; short_label: string; count: number; owner_function: string }[];
  feedback: BenchmarkFeedbackRecord[];
  alerts: BenchmarkAlert[];
};

type DuplicateCandidate = {
  candidate_id: string;
  match_type: 'exact_text' | 'near_text';
  similarity: number;
  issue_match: boolean;
  issue_type_ids: string[];
  category: string;
  store_id: string;
  store_name: string;
  region: string;
  week_index: number;
  channels: string[];
  records: BenchmarkFeedbackRecord[];
};

type DuplicateQueue = {
  summary: {
    candidate_count: number;
    exact_text_groups: number;
    near_text_pairs: number;
    scanned_feedback_records: number;
  };
  candidates: DuplicateCandidate[];
  scope: string;
  method_note: string;
};

type PendingLiveDuplicate = {
  incident: IncidentRecord;
  similarity: number;
  match_type: 'exact_text' | 'near_text';
  matched_text: string;
  matched_source: string;
  matched_at: string;
  feedback_text: string;
  source: string;
  store_id: string;
  analysis: FeedbackAnalysis;
};

type DuplicateReview = DuplicateReviewDecision;

const DUPLICATE_REVIEW_STORAGE_KEY = 'voice-of-store-r5-duplicate-reviews-v1';

function readDuplicateReviews(): Record<string, DuplicateReview> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DUPLICATE_REVIEW_STORAGE_KEY) || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === 'same' || value === 'separate')) as Record<string, DuplicateReview>;
  } catch {
    return {};
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

async function loadRegionalReportingData(client: SupabaseClient): Promise<RegionalReportingData> {
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const rates = await loadStoreWeeklyIssueRates(client, since);
  const period = latestReportingPeriod(rates);
  if (!period) return { rates, incidents: [], evidence: [] };
  const completedRates = rates.filter((row) => new Date(row.period_end).getTime() <= Date.now());
  const periodStart = completedRates
    .map((row) => row.period_start)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!periodStart) return { rates, incidents: [], evidence: [] };
  const [periodEvidence, legacyPeriodIncidents] = await Promise.all([
    loadIncidentEvidenceForPeriod(client, periodStart, period.periodEnd),
    loadIncidents(client, periodStart, period.periodEnd),
  ]);
  const incidentIds = [...new Set([
    ...periodEvidence.map((item) => item.incident_id),
    ...legacyPeriodIncidents.map((incident) => incident.id),
  ])];
  const [linkedIncidents, evidence] = await Promise.all([
    loadIncidentsByIds(client, incidentIds),
    loadIncidentEvidenceForIncidents(client, incidentIds),
  ]);
  const linkedById = new Map(linkedIncidents.map((incident) => [incident.id, incident]));
  for (const incident of legacyPeriodIncidents) linkedById.set(incident.id, incident);
  const incidents = [...linkedById.values()];
  return { rates, incidents, evidence };
}

function combineIncidentEvidence(...groups: IncidentEvidence[][]): IncidentEvidence[] {
  const byId = new Map<string, IncidentEvidence>();
  for (const evidence of groups.flat()) byId.set(evidence.id, evidence);
  return [...byId.values()];
}

const recognizedCategories = new Set([
  'Equipment failure',
  'Food safety',
  'Payment failure',
  'Availability',
  'Checkout',
  'Product quality',
  'Store environment',
  'Staff behavior',
  'Unknown',
  'Informational',
]);

function isRecognizedCategory(analysis: FeedbackAnalysis): boolean {
  // The organizer taxonomy has 33 labels; the trained API returns its display
  // name while the static demo dashboard intentionally keeps its own categories.
  return recognizedCategories.has(analysis.category) || analysis.classification_method === 'tfidf_linear_svc+taxonomy_policy';
}

function classificationMethodLabel(method: string): string {
  if (method === 'tfidf_linear_svc+taxonomy_policy') return 'TF-IDF classifiers · taxonomy policy';
  if (method.includes('safety_policy')) return 'Keyword safety rules';
  if (method.includes('fallback')) return 'Keyword rules · model unavailable';
  return 'Keyword rules';
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    online_review: 'Online review',
    in_app: 'In-app feedback',
    staff_shift_note: 'Staff shift note',
    call_centre_ticket: 'Call-centre ticket',
  };
  return labels[source] ?? source.replaceAll('_', ' ');
}

function isFeedbackAnalysis(value: unknown): value is FeedbackAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.feedback_text === 'string' &&
    (typeof result.store_name === 'string' || result.store_name === null) &&
    (typeof result.store_id === 'string' || result.store_id === null) &&
    typeof result.source === 'string' &&
    typeof result.category === 'string' &&
    typeof result.severity === 'string' &&
    typeof result.actionability === 'string' &&
    ['actionable', 'needs_review', 'informational'].includes(result.actionability) &&
    typeof result.recommended_department === 'string' &&
    typeof result.recommended_action === 'string' &&
    typeof result.explanation === 'string' &&
    typeof result.status === 'string' &&
    typeof result.requires_human_verification === 'boolean' &&
    typeof result.escalation_required === 'boolean' &&
    typeof result.classification_method === 'string'
  );
}

function responseErrorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('detail' in payload)) return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (typeof item === 'object' && item !== null && 'msg' in item ? String(item.msg) : ''))
      .filter(Boolean);
    if (messages.length) return messages.join(' ');
  }
  return null;
}

type Metric = {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone: string;
  movement?: 'up' | 'down';
  spark: number[];
};

const severityFilters: SeverityFilter[] = ['All', 'Critical', 'High', 'Medium', 'Low', 'Unclassified'];
const departmentOptions = [
  'Facilities & Maintenance',
  'Food Safety',
  'Digital / Technical Support',
  'Supply Chain',
  'Front End Operations',
  'Merchandising',
  'Facilities & Housekeeping',
  'Store Leadership',
  'Store Operations',
];
const incidentStatuses: IncidentStatus[] = [
  'Open',
  'In Progress',
  'Resolved',
];

const exampleFeedback = [
  { label: 'Noisy English', source: 'online_review', text: 'freezer not cooling… ice cream soft since 10am 😟 pls chk' },
  { label: 'Hinglish · billing', source: 'in_app', text: 'Billing wale bahut slow hain, line lambi hai aur staff rude tha 😠' },
  { label: 'Tamil transliteration', source: 'staff_shift_note', text: 'Freezer la ice cream melt aagudhu, inniku check pannunga 😟' },
  { label: 'Marathi transliteration', source: 'call_centre_ticket', text: 'Freezer chalu nahiye, ice cream pighalat aahe; please check.' },
];

const metrics: Metric[] = [
  {
    label: 'Total feedback',
    value: '—',
    detail: 'No records loaded',
    icon: <MessageSquareText size={19} strokeWidth={1.9} />,
    tone: 'blue',
    spark: Array(12).fill(0),
  },
  {
    label: 'Open incidents',
    value: '—',
    detail: 'No records loaded',
    icon: <ClipboardList size={19} strokeWidth={1.9} />,
    tone: 'teal',
    spark: Array(12).fill(0),
  },
  {
    label: 'Critical incidents',
    value: '—',
    detail: 'No records loaded',
    icon: <ShieldAlert size={19} strokeWidth={1.9} />,
    tone: 'coral',
    spark: Array(12).fill(0),
  },
  {
    label: 'Affected stores',
    value: '—',
    detail: 'No records loaded',
    icon: <MapPin size={19} strokeWidth={1.9} />,
    tone: 'amber',
    spark: Array(12).fill(0),
  },
];

function MiniSparkline({ values, tone }: { values: number[]; tone: string }) {
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${34 - value * 1.7}`)
    .join(' ');

  return (
    <svg className={`mini-sparkline ${tone}`} viewBox="0 0 100 38" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone,
  movement,
  spark,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone: string;
  movement?: 'up' | 'down';
  spark: number[];
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div className="metric-label">{label}</div>
      <div className="metric-value-row">
        <strong className="metric-value">{value}</strong>
        <MiniSparkline values={spark} tone={tone} />
      </div>
      <div className="metric-footnote">
        {movement === 'down' ? <ArrowDownRight size={14} /> : movement === 'up' ? <ArrowUpRight size={14} /> : null}
        <span>{detail}</span>
      </div>
    </article>
  );
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="button button-secondary export-button" onClick={onClick} type="button">
      <Download size={16} />
      <span>Export report</span>
    </button>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<SeverityFilter>('All');
  const [storeFilter, setStoreFilter] = useState('All stores');
  const [regionFilter, setRegionFilter] = useState('All regions');
  const [categoryFilter, setCategoryFilter] = useState('All categories');
  const [ownerFilter, setOwnerFilter] = useState('All owners');
  const [channelFilter, setChannelFilter] = useState('All channels');
  const [statusFilter, setStatusFilter] = useState('All statuses');
  const [activeNav, setActiveNav] = useState('overview');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [trendMenuOpen, setTrendMenuOpen] = useState(false);
  const [trendWindow, setTrendWindow] = useState<'recent' | 'all'>('recent');
  const [localStoreSnapshot, setLocalStoreSnapshot] = useState(loadLocalIncidentSnapshot);
  const [dataView, setDataView] = useState<DataView>(() => initialDataView(localStoreSnapshot));
  const [feedbackText, setFeedbackText] = useState('');
  const [storeIdentifier, setStoreIdentifier] = useState('');
  const [storeIdentifierType, setStoreIdentifierType] = useState<'name' | 'id'>('name');
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [source, setSource] = useState('online_review');
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [pendingLiveDuplicate, setPendingLiveDuplicate] = useState<PendingLiveDuplicate | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const sessionUserIdRef = useRef<string | null>(null);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [sessionRestoreError, setSessionRestoreError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isGoogleSigningIn, setIsGoogleSigningIn] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [memberships, setMemberships] = useState<StoreMembership[]>([]);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const localIncidents = localStoreSnapshot.records;
  const [weeklyIssueRates, setWeeklyIssueRates] = useState<StoreWeeklyIssueRate[]>([]);
  const [reportIncidents, setReportIncidents] = useState<IncidentRecord[]>([]);
  const [reportEvidence, setReportEvidence] = useState<IncidentEvidence[]>([]);
  const [benchmarkData, setBenchmarkData] = useState<BenchmarkOverview | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(true);
  const [benchmarkError, setBenchmarkError] = useState('');
  const [selectedBenchmarkRegion, setSelectedBenchmarkRegion] = useState('');
  const [selectedBenchmarkWeek, setSelectedBenchmarkWeek] = useState(0);
  const [benchmarkBrief, setBenchmarkBrief] = useState<BenchmarkBrief | null>(null);
  const [benchmarkBriefLoading, setBenchmarkBriefLoading] = useState(false);
  const [benchmarkBriefError, setBenchmarkBriefError] = useState('');
  const [duplicateQueue, setDuplicateQueue] = useState<DuplicateQueue | null>(null);
  const [duplicateQueueLoading, setDuplicateQueueLoading] = useState(true);
  const [duplicateQueueError, setDuplicateQueueError] = useState('');
  const [duplicateReviews, setDuplicateReviews] = useState<Record<string, DuplicateReview>>(readDuplicateReviews);
  const [duplicateReviewVotes, setDuplicateReviewVotes] = useState<DuplicateReviewVote[]>([]);
  const [duplicateReviewLoading, setDuplicateReviewLoading] = useState(false);
  const [duplicateReviewSavingId, setDuplicateReviewSavingId] = useState('');
  const [duplicateReviewSyncError, setDuplicateReviewSyncError] = useState('');
  const [lastIncidentSyncAt, setLastIncidentSyncAt] = useState<Date | null>(null);
  const [isLoadingIncidents, setIsLoadingIncidents] = useState(false);
  const [isSavingIncident, setIsSavingIncident] = useState(false);
  const [incidentError, setIncidentError] = useState('');
  const [updatingIncidentId, setUpdatingIncidentId] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('All authorized regions');
  const [selectedLiveWeekStart, setSelectedLiveWeekStart] = useState('');

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    setPendingLiveDuplicate(null);
  }, [session?.user.id]);

  useEffect(() => {
    setStoreFilter('All stores');
    setRegionFilter('All regions');
    setCategoryFilter('All categories');
    setOwnerFilter('All owners');
    setChannelFilter('All channels');
    setStatusFilter('All statuses');
    setSeverity('All');
    setQuery('');
  }, [dataView]);

  useEffect(() => {
    let active = true;
    setBenchmarkLoading(true);
    void fetch(`${API_BASE_URL}/r5/benchmark?feedback_limit=12&alert_limit=10`)
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(responseErrorMessage(payload) || `Benchmark request failed (${response.status}).`);
        if (typeof payload !== 'object' || payload === null || !('summary' in payload) || !('trend' in payload)) {
          throw new Error('The R5 benchmark response is incomplete. Restart the backend after updating it.');
        }
        return payload as BenchmarkOverview;
      })
      .then((payload) => {
        if (!active) return;
        setBenchmarkData(payload);
        setSelectedBenchmarkRegion((current) => current || payload.summary.regions[0] || '');
        setSelectedBenchmarkWeek((current) => current || payload.summary.weeks);
        setBenchmarkError('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBenchmarkError(error instanceof TypeError
          ? 'Could not reach the backend. Start FastAPI to load the official R5 benchmark.'
          : error instanceof Error ? error.message : 'The R5 benchmark could not be loaded.');
      })
      .finally(() => { if (active) setBenchmarkLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch(`${API_BASE_URL}/r5/benchmark/duplicates?limit=30`)
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(responseErrorMessage(payload) || `Duplicate review queue failed (${response.status}).`);
        return payload as DuplicateQueue;
      })
      .then((payload) => {
        if (!active) return;
        setDuplicateQueue(payload);
        setDuplicateQueueError('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDuplicateQueueError(error instanceof TypeError
          ? 'The duplicate review queue could not reach FastAPI.'
          : error instanceof Error ? error.message : 'The duplicate review queue could not be loaded.');
      })
      .finally(() => { if (active) setDuplicateQueueLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DUPLICATE_REVIEW_STORAGE_KEY, JSON.stringify(duplicateReviews));
    } catch {
      // The review remains usable for this page session if browser storage is unavailable.
    }
  }, [duplicateReviews]);

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setDuplicateReviewVotes([]);
      setDuplicateReviewSyncError('');
      setDuplicateReviewLoading(false);
      return;
    }
    let active = true;
    setDuplicateReviewLoading(true);
    void loadDuplicateReviewVotes(supabase)
      .then((votes) => {
        if (!active) return;
        setDuplicateReviewVotes(votes);
        setDuplicateReviewSyncError('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDuplicateReviewSyncError(error instanceof Error
          ? `Shared review storage is unavailable: ${error.message}`
          : 'Shared review storage is unavailable. Apply the duplicate-review migration and try again.');
      })
      .finally(() => { if (active) setDuplicateReviewLoading(false); });
    return () => { active = false; };
  }, [session?.user.id]);

  const duplicateReviewStatus = useMemo(() => {
    const grouped: Record<string, { same: number; separate: number; myDecision: DuplicateReview | null; consensus: DuplicateReview | null }> = {};
    for (const vote of duplicateReviewVotes) {
      const status = grouped[vote.candidate_id] ?? { same: 0, separate: 0, myDecision: null, consensus: null };
      status[vote.decision] += 1;
      if (vote.reviewer_id === session?.user.id) status.myDecision = vote.decision;
      status.consensus = status.same > status.separate ? 'same' : status.separate > status.same ? 'separate' : null;
      grouped[vote.candidate_id] = status;
    }
    return grouped;
  }, [duplicateReviewVotes, session?.user.id]);

  const sharedDuplicateReviewMode = Boolean(supabase && session?.user.id);

  const confirmedDuplicateRemovals = useMemo(() => {
    type ReviewGroup = { parent: Map<string, string>; records: Map<string, BenchmarkFeedbackRecord> };
    const groups = new Map<string, ReviewGroup>();
    const find = (parent: Map<string, string>, id: string): string => {
      const current = parent.get(id);
      if (!current || current === id) return id;
      const root = find(parent, current);
      parent.set(id, root);
      return root;
    };
    for (const candidate of duplicateQueue?.candidates ?? []) {
      const review = sharedDuplicateReviewMode
        ? duplicateReviewStatus[candidate.candidate_id]?.consensus
        : duplicateReviews[candidate.candidate_id];
      if (review !== 'same' || !candidate.issue_match || !candidate.issue_type_ids.length) continue;
      const issueId = candidate.issue_type_ids[0];
      const key = `${candidate.region}|${candidate.week_index}|${issueId}`;
      const group = groups.get(key) ?? { parent: new Map<string, string>(), records: new Map<string, BenchmarkFeedbackRecord>() };
      const ids = candidate.records.map((record) => record.feedback_id);
      for (const record of candidate.records) {
        if (!group.parent.has(record.feedback_id)) group.parent.set(record.feedback_id, record.feedback_id);
        group.records.set(record.feedback_id, record);
      }
      for (const id of ids.slice(1)) {
        const root = find(group.parent, ids[0]);
        const other = find(group.parent, id);
        if (root !== other) group.parent.set(other, root);
      }
      groups.set(key, group);
    }
    const removals: Record<string, { count: number; removedIds: string[]; removedStoreById: Record<string, string> }> = {};
    for (const [key, group] of groups) {
      const components = new Map<string, BenchmarkFeedbackRecord[]>();
      for (const record of group.records.values()) {
        const root = find(group.parent, record.feedback_id);
        components.set(root, [...(components.get(root) ?? []), record]);
      }
      const removedRecords = [...components.values()].flatMap((component) =>
        component.length > 1
          ? component.sort((left, right) => left.created_at.localeCompare(right.created_at)).slice(1)
          : [],
      );
      removals[key] = {
        count: removedRecords.length,
        removedIds: removedRecords.map((record) => record.feedback_id),
        removedStoreById: Object.fromEntries(removedRecords.map((record) => [record.feedback_id, record.store_id])),
      };
    }
    return removals;
  }, [duplicateQueue, duplicateReviews, duplicateReviewStatus, sharedDuplicateReviewMode]);

  const displayedBenchmarkBrief = useMemo(() => {
    if (!benchmarkBrief) return null;
    const currentPrefix = `${benchmarkBrief.region}|${benchmarkBrief.week_index}|`;
    const previousPrefix = benchmarkBrief.previous_week_index === null
      ? ''
      : `${benchmarkBrief.region}|${benchmarkBrief.previous_week_index}|`;
    const removalsForPeriod = (prefix: string) => Object.entries(confirmedDuplicateRemovals)
      .filter(([key]) => prefix && key.startsWith(prefix))
      .reduce((total, [, removal]) => total + removal.count, 0);
    const currentRemoved = removalsForPeriod(currentPrefix);
    const previousRemoved = removalsForPeriod(previousPrefix);
    const allIssues = benchmarkBrief.all_issues.map((issue) => {
      const currentRemoval = confirmedDuplicateRemovals[`${benchmarkBrief.region}|${benchmarkBrief.week_index}|${issue.issue_type_id}`];
      const previousRemoval = benchmarkBrief.previous_week_index === null
        ? undefined
        : confirmedDuplicateRemovals[`${benchmarkBrief.region}|${benchmarkBrief.previous_week_index}|${issue.issue_type_id}`];
      const currentRateRemoval = Object.entries(currentRemoval?.removedStoreById ?? {})
        .filter(([, storeId]) => issue.rate_store_ids.includes(storeId)).length;
      const previousRateRemoval = Object.entries(previousRemoval?.removedStoreById ?? {})
        .filter(([, storeId]) => issue.previous_rate_store_ids.includes(storeId)).length;
      const currentRate = issue.normalized_rate_per_1000_exposure === null
        ? null
        : Math.max(0, issue.normalized_rate_per_1000_exposure - currentRateRemoval * 1000 / Math.max(issue.rate_denominator, 1));
      const previousRate = issue.previous_rate_per_1000_exposure === null
        ? null
        : Math.max(0, issue.previous_rate_per_1000_exposure - previousRateRemoval * 1000 / Math.max(issue.previous_rate_denominator, 1));
      const trend: BenchmarkBriefIssue['trend'] = currentRate === null || previousRate === null
        ? 'no_baseline'
        : currentRate > previousRate ? 'up' : currentRate < previousRate ? 'down' : 'flat';
      const removedIds = new Set(currentRemoval?.removedIds ?? []);
      return {
        ...issue,
        feedback_count: Math.max(0, issue.feedback_count - (currentRemoval?.count ?? 0)),
        rate_feedback_count: Math.max(0, issue.rate_feedback_count - currentRateRemoval),
        normalized_rate_per_1000_exposure: currentRate,
        previous_feedback_count: issue.previous_feedback_count === null
          ? null
          : Math.max(0, issue.previous_feedback_count - (previousRemoval?.count ?? 0)),
        previous_rate_per_1000_exposure: previousRate,
        trend,
        quotes: issue.quotes.filter((quote) => !removedIds.has(quote.feedback_id)),
      };
    });
    const issues = allIssues
      .filter((issue) => issue.feedback_count > 0)
      .sort((left, right) => right.feedback_count - left.feedback_count || left.issue_type_id.localeCompare(right.issue_type_id))
      .slice(0, 5);
    return {
      ...benchmarkBrief,
      feedback_rows: Math.max(0, benchmarkBrief.feedback_rows - currentRemoved),
      previous_week_feedback_rows: Math.max(0, benchmarkBrief.previous_week_feedback_rows - previousRemoved),
      confirmed_deduplicated_reports: currentRemoved,
      all_issues: allIssues,
      issues,
      empty_period_message: issues.length === 0 && benchmarkBrief.issues.length > 0
        ? 'Confirmed duplicate reviews collapsed the remaining actionable reports for this period.'
        : benchmarkBrief.empty_period_message,
    };
  }, [benchmarkBrief, confirmedDuplicateRemovals]);

  useEffect(() => {
    if (!benchmarkData || !selectedBenchmarkRegion || selectedBenchmarkWeek < 1) return;
    let active = true;
    const params = new URLSearchParams({ region: selectedBenchmarkRegion, week_index: String(selectedBenchmarkWeek) });
    setBenchmarkBriefLoading(true);
    void fetch(`${API_BASE_URL}/r5/benchmark/brief?${params.toString()}`)
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(responseErrorMessage(payload) || `Weekly brief request failed (${response.status}).`);
        return payload as BenchmarkBrief;
      })
      .then((payload) => {
        if (!active) return;
        setBenchmarkBrief(payload);
        setBenchmarkBriefError('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBenchmarkBrief(null);
        setBenchmarkBriefError(error instanceof TypeError
          ? 'The regional weekly brief could not reach FastAPI.'
          : error instanceof Error ? error.message : 'The regional weekly brief could not be loaded.');
      })
      .finally(() => { if (active) setBenchmarkBriefLoading(false); });
    return () => { active = false; };
  }, [benchmarkData, selectedBenchmarkRegion, selectedBenchmarkWeek]);

  useEffect(() => {
    const decision = authRouteDecision(currentPath, isCheckingSession, Boolean(session));
    const destination = decision === 'redirect-login'
      ? '/login'
      : decision === 'redirect-dashboard'
        ? '/'
        : null;
    if (destination && window.location.pathname !== destination) {
      window.history.replaceState(null, '', destination);
      setCurrentPath(destination);
    }
  }, [currentPath, isCheckingSession, session]);

  useEffect(() => {
    let active = true;
    if (!supabase) {
      setSession(null);
      setIsCheckingSession(false);
      return () => { active = false; };
    }

    let authEventObserved = false;
    const clearAccountScopedState = () => {
      setDataView(dataViewAfterAccountChange);
      setAnalysis(null);
      setAnalysisError('');
      setAnalysisNotice('');
      setMemberships([]);
      setIncidents([]);
      setWeeklyIssueRates([]);
      setReportIncidents([]);
      setReportEvidence([]);
      setLastIncidentSyncAt(null);
      setSelectedStoreId('');
      setSelectedRegion('All authorized regions');
      setIsLoadingIncidents(false);
      setIsAnalyzing(false);
      setIsSavingIncident(false);
      setIncidentError('');
      setUpdatingIncidentId('');
    };
    const applySession = (nextSession: Session | null) => {
      const nextUserId = nextSession?.user.id ?? null;
      if (sessionUserIdRef.current !== nextUserId) clearAccountScopedState();
      sessionUserIdRef.current = nextUserId;
      setSession(nextSession);
      setSessionRestoreError('');
      if (!nextSession) setDataView(dataViewAfterAccountChange);
      setIsCheckingSession(false);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      authEventObserved = true;
      applySession(nextSession);
    });

    void restoreSupabaseSession(supabase.auth)
      .then((restoredSession) => {
        if (active && !authEventObserved) applySession(restoredSession);
      })
      .catch(() => {
        if (!active || authEventObserved) return;
        setSession(null);
        setSessionRestoreError('We could not restore your Supabase session. Please sign in again.');
      })
      .finally(() => {
        if (active) setIsCheckingSession(false);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!client || !session) {
      setMemberships([]);
      setIncidents([]);
      setWeeklyIssueRates([]);
      setReportIncidents([]);
      setReportEvidence([]);
      setLastIncidentSyncAt(null);
      setSelectedStoreId('');
      setSelectedRegion('All authorized regions');
      setIsLoadingIncidents(false);
      setIncidentError('');
      return;
    }

    let active = true;
    setDataView(dataViewAfterAccountChange);
    setMemberships([]);
    setIncidents([]);
    setWeeklyIssueRates([]);
    setReportIncidents([]);
    setReportEvidence([]);
    setLastIncidentSyncAt(null);
    setSelectedStoreId('');
    setSelectedRegion('All authorized regions');
    setSelectedLiveWeekStart('');
    setIsLoadingIncidents(true);
    setIncidentError('');
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    void Promise.all([
      loadStoreMemberships(client),
      loadIncidents(client, since),
      loadRegionalReportingData(client),
    ])
      .then(async ([nextMemberships, nextIncidents, reporting]) => {
        const incidentEvidence = await loadIncidentEvidenceForIncidents(
          client,
          nextIncidents.map((incident) => incident.id),
        ).catch(() => []);
        if (!active) return;
        setMemberships(nextMemberships);
        setIncidents(nextIncidents);
        setWeeklyIssueRates(reporting.rates);
        setReportIncidents(reporting.incidents);
        setReportEvidence(combineIncidentEvidence(reporting.evidence, incidentEvidence));
        setLastIncidentSyncAt(new Date());
        setSelectedStoreId((current) =>
          nextMemberships.some((membership) => membership.store.id === current)
            ? current
            : nextMemberships[0]?.store.id ?? '',
        );
      })
      .catch((error: unknown) => {
        if (active) setIncidentError(error instanceof Error ? error.message : 'Could not load authorized incidents.');
      })
      .finally(() => {
        if (active) setIsLoadingIncidents(false);
      });

    return () => { active = false; };
  }, [session?.user.id]);

  const selectedMembership = memberships.find((membership) => membership.store.id === selectedStoreId);

  const handleAuth = async (mode: AuthMode, email: string, password: string) => {
    if (!supabase) return;
    if (!email || !password) {
      setAuthError('Enter an email address and password.');
      return;
    }
    if (mode === 'sign_up' && password.length < 8) {
      setAuthError('Use a password with at least 8 characters.');
      return;
    }

    setIsAuthenticating(true);
    setAuthError('');
    setAuthNotice('');
    try {
      if (mode === 'sign_in') {
        await signInWithEmailPassword(supabase.auth, email, password);
        setAuthNotice('Signed in. Loading your authorized stores and incidents…');
      } else {
        const result = await signUpWithEmailPassword(
          supabase.auth,
          email,
          password,
          `${window.location.origin}/login`,
        );
        setAuthNotice(result.confirmationRequired
          ? 'If email confirmation is enabled, check your inbox for a confirmation link. Return here to sign in after confirming.'
          : 'Your account is ready. Opening your workspace…');
      }
    } catch (error) {
      setAuthError(error instanceof TypeError
        ? 'Could not reach Supabase Auth. Check your connection and project URL.'
        : error instanceof Error && error.message.length < 240
          ? error.message
          : 'Authentication could not be completed. Please try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!supabase) return;
    setIsGoogleSigningIn(true);
    setAuthError('');
    setAuthNotice('');
    try {
      await signInWithGoogle(supabase.auth, `${window.location.origin}/`);
    } catch (error) {
      setAuthError(error instanceof TypeError
        ? 'Could not reach Supabase Auth. Check your connection and project URL.'
        : error instanceof Error && error.message.length < 240
          ? error.message
          : 'Google sign-in could not be started. Please try again.');
    } finally {
      setIsGoogleSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    setAuthError('');
    setIsSigningOut(true);
    try {
      await signOutFromSupabase(supabase.auth);
      sessionUserIdRef.current = null;
      setSession(null);
      setPendingLiveDuplicate(null);
      setAuthNotice('You have signed out.');
    } catch (error) {
      setAuthError(error instanceof TypeError
        ? 'Could not reach Supabase Auth to sign out. Check your connection and try again.'
        : error instanceof Error && error.message.length < 240
          ? error.message
          : 'Sign out could not be completed. Please try again.');
    } finally {
      setIsSigningOut(false);
    }
  };

  const liveTrend = useMemo(() => buildLiveTrend(incidents), [incidents]);
  const localTrend = useMemo(() => buildLiveTrend(localIncidents), [localIncidents]);
  const liveCategorySignals = useMemo(() => buildLiveCategorySignals(incidents), [incidents]);
  const localCategorySignals = useMemo(() => buildLiveCategorySignals(localIncidents), [localIncidents]);
  const activeIncidents = dataView === 'local' ? localIncidents : incidents;
  const openIncidents = activeIncidents.filter((incident) => !['Resolved', 'Informational'].includes(incident.status));
  const notificationCount = dataView === 'demo'
    ? benchmarkData?.summary.emerging_flag_rows ?? 0
    : openIncidents.length;
  const activeTrend = dataView === 'live'
    ? liveTrend
    : dataView === 'local'
      ? localTrend
      : benchmarkData?.trend.map((point) => ({ ...point, day: point.week })) ?? [];
  const visibleTrend = trendWindow === 'all' ? activeTrend : activeTrend.slice(-8);
  const activeCategorySignals = dataView === 'live'
    ? liveCategorySignals
    : dataView === 'local'
      ? localCategorySignals
      : benchmarkData?.categories.map((item) => ({ category: item.category, shortLabel: item.short_label, count: item.count })) ?? [];
  const emergingIssues = useMemo(() => findEmergingIssues(weeklyIssueRates), [weeklyIssueRates]);
  const authorizedStores = useMemo(
    () => memberships.map((membership) => membership.store),
    [memberships],
  );
  const liveReportWeeks = useMemo(() => {
    const reportRegions = selectedRegion === 'All authorized regions'
      ? new Set(authorizedStores.map((store) => store.region))
      : new Set([selectedRegion]);
    const periods = new Map<string, { periodStart: string; periodEnd: string }>();
    for (const row of weeklyIssueRates) {
      if (!reportRegions.has(row.region) || new Date(row.period_end).getTime() > Date.now()) continue;
      periods.set(row.period_start, { periodStart: row.period_start, periodEnd: row.period_end });
    }
    return [...periods.values()].sort((left, right) => right.periodStart.localeCompare(left.periodStart));
  }, [authorizedStores, selectedRegion, weeklyIssueRates]);
  const activeLiveWeekStart = liveReportWeeks.some((period) => period.periodStart === selectedLiveWeekStart)
    ? selectedLiveWeekStart
    : liveReportWeeks[0]?.periodStart ?? '';
  const regionalSummaries = useMemo(
    () => summarizeRegions(weeklyIssueRates, authorizedStores, reportIncidents, reportEvidence, new Date(), activeLiveWeekStart || undefined),
    [activeLiveWeekStart, authorizedStores, reportEvidence, reportIncidents, weeklyIssueRates],
  );
  const displayedMetrics = useMemo<Metric[]>(() => {
    if (dataView === 'demo') {
      const summary = benchmarkData?.summary;
      const spark = benchmarkData?.trend.slice(-12).map((point) => point.total) ?? [];
      const flagsSpark = benchmarkData?.trend.slice(-12).map((point) => point.high + point.critical) ?? [];
      return [
        { ...metrics[0], label: 'Organizer feedback', value: summary ? summary.feedback_records.toLocaleString() : benchmarkLoading ? '…' : '—', detail: summary ? 'All channels · 26 official weeks' : benchmarkError || 'Waiting for public benchmark', spark, movement: undefined },
        { ...metrics[1], label: 'Complete predictions', value: summary ? summary.prediction_records.toLocaleString() : benchmarkLoading ? '…' : '—', detail: summary ? `${summary.public_training_labels.toLocaleString()} public training labels` : 'Generated output coverage', spark, movement: undefined },
        { ...metrics[2], label: 'Taxonomy categories', value: summary ? String(summary.taxonomy_categories) : benchmarkLoading ? '…' : '—', detail: summary ? `${summary.stores} stores · ${summary.regions.length} regions` : 'Official organizer taxonomy', spark: flagsSpark, movement: undefined },
        { ...metrics[3], label: 'Evidence-backed flags', value: summary ? String(summary.emerging_flag_rows) : benchmarkLoading ? '…' : '—', detail: summary ? `${summary.valid_evidence_ids} evidence IDs validated` : 'Public detector output', spark: flagsSpark, movement: undefined },
      ];
    }
    const openCount = activeIncidents.filter((incident) => !['Resolved', 'Informational'].includes(incident.status)).length;
    const criticalCount = activeIncidents.filter((incident) => incident.severity === 'Critical').length;
    const storeCount = new Set(activeIncidents.map((incident) => incident.store_id)).size;
    return [
      { ...metrics[0], value: String(activeIncidents.length), detail: dataView === 'local' ? 'Saved on this browser' : 'Saved incidents · last 14 days', spark: activeTrend.map((point) => point.critical + point.high + point.medium + point.low + ('unclassified' in point && typeof point.unclassified === 'number' ? point.unclassified : 0)), movement: undefined },
      { ...metrics[1], value: String(openCount), detail: dataView === 'local' ? 'Not resolved · local records' : 'Not resolved · last 14 days', spark: activeTrend.map((point) => point.high + point.medium + point.low), movement: undefined },
      { ...metrics[2], value: String(criticalCount), detail: dataView === 'local' ? 'Critical local reports' : 'Critical reports · last 14 days', spark: activeTrend.map((point) => point.critical), movement: undefined },
      { ...metrics[3], value: String(storeCount), detail: dataView === 'local' ? 'Stores represented locally' : 'Authorized stores with incidents', spark: activeTrend.map((point) => point.critical + point.high), movement: undefined },
    ];
  }, [activeIncidents, activeTrend, benchmarkData, benchmarkError, benchmarkLoading, dataView]);

  const displayItems = useMemo<DisplayFeedback[]>(() => {
    if (dataView !== 'demo') {
      const evidenceCounts = new Map<string, number>();
      for (const evidence of reportEvidence) evidenceCounts.set(evidence.incident_id, (evidenceCounts.get(evidence.incident_id) ?? 0) + 1);
      return activeIncidents.map((incident) => ({
        id: incident.id,
        text: incident.feedback_text,
        source: incident.source,
        store: incident.store?.name ?? 'Store not available',
        region: incident.store?.region ?? 'Region not configured',
        location: incident.store?.region ?? 'Region not configured',
        category: incident.category,
        severity: incident.severity,
        status: incident.status,
        received: new Date(incident.created_at).toLocaleString(),
        assignedDepartment: incident.assigned_department,
        recommendedAction: incident.recommended_action,
        evidenceCount: Math.max(1, evidenceCounts.get(incident.id) ?? 0),
        requiresHumanVerification: incident.requires_human_verification,
        humanVerifiedAt: incident.human_verified_at,
        incidentId: incident.id,
      }));
    }
    return (benchmarkData?.feedback ?? []).map((item) => ({
      id: item.feedback_id,
      text: item.text,
      source: item.channel,
      store: item.store_name,
      region: item.region,
      location: `${item.region} · ${item.location}`,
      category: item.category,
      severity: item.severity,
      status: 'Benchmark output',
      received: new Date(item.created_at).toLocaleString(),
      assignedDepartment: item.assigned_department,
      recommendedAction: 'Historical benchmark prediction · the organizer data has no task completion status.',
      evidenceCount: 1,
      requiresHumanVerification: false,
      humanVerifiedAt: null,
    }));
  }, [activeIncidents, benchmarkData, dataView, reportEvidence]);

  const visibleFeedback = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return displayItems.filter((item) => {
      const matchesSeverity = severity === 'All' || item.severity === severity;
      const matchesStore = storeFilter === 'All stores' || item.store === storeFilter;
      const matchesRegion = regionFilter === 'All regions' || item.region === regionFilter;
      const matchesCategory = categoryFilter === 'All categories' || item.category === categoryFilter;
      const matchesOwner = ownerFilter === 'All owners' || item.assignedDepartment === ownerFilter;
      const matchesChannel = channelFilter === 'All channels' || item.source === channelFilter;
      const matchesStatus = statusFilter === 'All statuses' || item.status === statusFilter;
      const matchesSearch =
        normalizedQuery.length === 0 ||
        [item.text, item.store, item.location, item.category, item.status, item.id, item.assignedDepartment, item.recommendedAction]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesSeverity && matchesStore && matchesRegion && matchesCategory && matchesOwner && matchesChannel && matchesStatus && matchesSearch;
    });
  }, [categoryFilter, channelFilter, displayItems, ownerFilter, query, regionFilter, severity, statusFilter, storeFilter]);

  const feedbackFilterOptions = useMemo(() => ({
    stores: [...new Set(displayItems.map((item) => item.store))].sort(),
    regions: [...new Set(displayItems.map((item) => item.region))].sort(),
    categories: [...new Set(displayItems.map((item) => item.category))].sort(),
    owners: [...new Set(displayItems.map((item) => item.assignedDepartment))].sort(),
    channels: [...new Set(displayItems.map((item) => item.source))].sort(),
    statuses: [...new Set(displayItems.map((item) => item.status))].sort(),
  }), [displayItems]);

  const updateSavedIncident = async (incidentId: string, changes: { status?: IncidentStatus; assigned_department?: string; human_verified_at?: string }) => {
    if (dataView === 'local') {
      setUpdatingIncidentId(incidentId);
      setIncidentError('');
      try {
        const records = updateLocalIncident(incidentId, changes);
        setLocalStoreSnapshot({ records, error: '' });
      } catch (error) {
        setIncidentError(error instanceof Error ? error.message : 'Local incident update failed.');
      } finally {
        setUpdatingIncidentId('');
      }
      return;
    }
    if (!supabase) return;
    const requestingUserId = session?.user.id ?? null;
    setUpdatingIncidentId(incidentId);
    setIncidentError('');
    try {
      const updated = await updateIncident(supabase, incidentId, changes);
      if (sessionUserIdRef.current !== requestingUserId) return;
      setIncidents((current) => current.map((incident) => incident.id === incidentId ? updated : incident));
      setLastIncidentSyncAt(new Date());
    } catch (error) {
      if (sessionUserIdRef.current === requestingUserId) {
        setIncidentError(error instanceof Error ? error.message : 'Incident update failed.');
      }
    } finally {
      if (sessionUserIdRef.current === requestingUserId) setUpdatingIncidentId('');
    }
  };

  const now = Date.now();
  const activeLastSevenTotal = activeIncidents.filter((incident) => {
    const createdAt = new Date(incident.created_at).getTime();
    return createdAt >= now - 7 * 24 * 60 * 60 * 1000 && createdAt <= now;
  }).length;
  const selectedRegionalSummaries = selectedRegion === 'All authorized regions'
    ? regionalSummaries
    : regionalSummaries.filter((summary) => summary.region === selectedRegion);

  const freshnessLabel = dataView === 'demo'
    ? 'Static demo data'
    : dataView === 'local'
      ? 'Stored in this browser only'
      : isLoadingIncidents
      ? 'Refreshing'
      : lastIncidentSyncAt
        ? `Synced ${lastIncidentSyncAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Not synced';

  const analyzeFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestingUserId = session?.user.id ?? null;
    const cleanedFeedback = feedbackText.trim();
    const cleanedStoreIdentifier = selectedMembership?.store.name ?? storeIdentifier.trim();
    if (!cleanedFeedback) {
      setAnalysisError('Enter the feedback text before analyzing it.');
      return;
    }
    if (cleanedFeedback.length > 2000) {
      setAnalysisError('Feedback must be 2,000 characters or fewer.');
      return;
    }
    if (!cleanedStoreIdentifier) {
      setAnalysisError('Enter a store name or store ID.');
      return;
    }

    setAnalysis(null);
    setPendingLiveDuplicate(null);
    setAnalysisError('');
    setAnalysisNotice('');
    setIsAnalyzing(true);
    const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

    try {
      if (supabase && session && selectedMembership) {
        const classificationResponse = await fetch(`${apiBaseUrl}/feedback/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedback_text: cleanedFeedback,
            store_id: selectedMembership.store.id,
            source,
          }),
        });
        const classificationPayload: unknown = await classificationResponse.json();
        if (!classificationResponse.ok) {
          throw new Error(responseErrorMessage(classificationPayload) || `The API returned an error (${classificationResponse.status}).`);
        }
        if (!isFeedbackAnalysis(classificationPayload)) {
          throw new Error('The API response had an unexpected format. Check that the backend is up to date.');
        }
        if (sessionUserIdRef.current !== requestingUserId) return;
        setAnalysis(classificationPayload);

        const duplicateMatch = findLiveDuplicateMatch(
          cleanedFeedback,
          selectedMembership.store.id,
          source,
          classificationPayload.category,
          incidents,
          reportEvidence,
        );
        if (duplicateMatch) {
          setPendingLiveDuplicate({
            incident: duplicateMatch.incident,
            similarity: duplicateMatch.similarity,
            match_type: duplicateMatch.match_type,
            matched_text: duplicateMatch.matched_text,
            matched_source: duplicateMatch.matched_source,
            matched_at: duplicateMatch.matched_at,
            feedback_text: cleanedFeedback,
            source,
            store_id: selectedMembership.store.id,
            analysis: classificationPayload,
          });
          setAnalysisNotice('Possible repeat found in this store. Choose whether to add this message as evidence or keep it as a separate incident.');
          return;
        }

        setIsSavingIncident(true);
        let created: CreatedIncidentResponse;
        try {
          created = await createIncident(apiBaseUrl, session.access_token, selectedMembership.store.id, cleanedFeedback, source);
        } finally {
          if (sessionUserIdRef.current === requestingUserId) setIsSavingIncident(false);
        }
        if (sessionUserIdRef.current !== requestingUserId) return;
        setAnalysis(created);
        setPendingLiveDuplicate(null);
        setDataView('live');
        setAnalysisNotice(`Saved incident ${created.incident_id.slice(0, 8)} and assigned it to ${created.assigned_department}. This is an in-app assignment; no external alert was sent.`);
        try {
          const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
          const refreshed = await loadIncidents(supabase, since);
          const [reporting, incidentEvidence] = await Promise.all([
            loadRegionalReportingData(supabase),
            loadIncidentEvidenceForIncidents(supabase, refreshed.map((incident) => incident.id)).catch(() => []),
          ]);
          if (sessionUserIdRef.current !== requestingUserId) return;
          setIncidents(refreshed);
          setWeeklyIssueRates(reporting.rates);
          setReportIncidents(reporting.incidents);
          setReportEvidence(combineIncidentEvidence(reporting.evidence, incidentEvidence));
          setLastIncidentSyncAt(new Date());
          setIncidentError('');
        } catch (error) {
          if (sessionUserIdRef.current !== requestingUserId) return;
          setIncidentError(error instanceof Error ? error.message : 'The incident was saved, but the live table could not refresh.');
          setAnalysisNotice(`Incident ${created.incident_id.slice(0, 8)} was saved. Refreshing the live register failed; reload the page to retry.`);
        }
      } else {
        const requestBody = {
          feedback_text: cleanedFeedback,
          ...(storeIdentifierType === 'name'
            ? { store_name: cleanedStoreIdentifier }
            : { store_id: cleanedStoreIdentifier }),
          source,
        };
        const response = await fetch(`${apiBaseUrl}/feedback/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new Error(responseErrorMessage(payload) || `The API returned an error (${response.status}).`);
        }
        if (!isFeedbackAnalysis(payload)) {
          throw new Error('The API response had an unexpected format. Check that the backend is up to date.');
        }
        if (sessionUserIdRef.current !== requestingUserId) return;
        setAnalysis(payload);
        try {
          const saved = saveLocalIncident(payload, cleanedStoreIdentifier, storeIdentifierType);
          setLocalStoreSnapshot((current) => ({ records: [saved, ...current.records], error: '' }));
          setDataView('local');
          setAnalysisNotice(`Saved ${saved.id.slice(0, 8)} in this browser only. Sign in and select an authorized store to persist it for your team.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Browser storage is unavailable.';
          setAnalysisNotice(`Analysis only; the incident was not saved. ${message}`);
        }
      }
    } catch (error) {
      if (sessionUserIdRef.current !== requestingUserId) return;
      setAnalysisError(
        error instanceof TypeError
          ? 'Could not reach the API. Start the FastAPI backend and confirm the API URL in frontend/.env.local.'
          : error instanceof Error
            ? error.message
            : 'The feedback could not be analyzed. Please try again.',
      );
    } finally {
      if (sessionUserIdRef.current === requestingUserId) setIsAnalyzing(false);
    }
  };

  const attachPendingDuplicateEvidence = async () => {
    const pending = pendingLiveDuplicate;
    if (!pending || !supabase || !session || !memberships.some((membership) => membership.store.id === pending.store_id)) return;
    const requestingUserId = session.user.id;
    setIsSavingIncident(true);
    setAnalysisError('');
    try {
      await attachIncidentEvidence(
        API_BASE_URL,
        session.access_token,
        pending.incident.id,
        pending.store_id,
        pending.feedback_text,
        pending.source,
      );
      if (sessionUserIdRef.current !== requestingUserId) return;
      setPendingLiveDuplicate(null);
      setDataView('live');
      setAnalysis({
        ...pending.analysis,
        incident_id: pending.incident.id,
        assigned_department: pending.incident.assigned_department,
        created_at: pending.incident.created_at,
        updated_at: pending.incident.updated_at,
      });
      setAnalysisNotice(`Added this ${sourceLabel(pending.source).toLowerCase()} message as supporting evidence for incident ${pending.incident.id.slice(0, 8)}. It remains one incident with multiple source reports.`);
      try {
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const refreshed = await loadIncidents(supabase, since);
        const [reporting, incidentEvidence] = await Promise.all([
          loadRegionalReportingData(supabase),
          loadIncidentEvidenceForIncidents(supabase, refreshed.map((incident) => incident.id)).catch(() => []),
        ]);
        if (sessionUserIdRef.current !== requestingUserId) return;
        setIncidents(refreshed);
        setWeeklyIssueRates(reporting.rates);
        setReportIncidents(reporting.incidents);
        setReportEvidence(combineIncidentEvidence(reporting.evidence, incidentEvidence));
        setLastIncidentSyncAt(new Date());
        setIncidentError('');
      } catch (error) {
        if (sessionUserIdRef.current !== requestingUserId) return;
        setIncidentError(error instanceof Error ? error.message : 'Evidence was saved, but the live report could not refresh.');
      }
    } catch (error) {
      if (sessionUserIdRef.current === requestingUserId) {
        setAnalysisError(error instanceof Error ? error.message : 'The evidence could not be attached.');
      }
    } finally {
      if (sessionUserIdRef.current === requestingUserId) setIsSavingIncident(false);
    }
  };

  const createSeparateIncident = async () => {
    const pending = pendingLiveDuplicate;
    if (!pending || !supabase || !session) return;
    const requestingUserId = session.user.id;
    setIsSavingIncident(true);
    setAnalysisError('');
    try {
      const created = await createIncident(
        API_BASE_URL,
        session.access_token,
        pending.store_id,
        pending.feedback_text,
        pending.source,
      );
      if (sessionUserIdRef.current !== requestingUserId) return;
      setPendingLiveDuplicate(null);
      setDataView('live');
      setAnalysis(created);
      setAnalysisNotice(`Created a separate incident ${created.incident_id.slice(0, 8)} after your review.`);
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const refreshed = await loadIncidents(supabase, since);
      const [reporting, incidentEvidence] = await Promise.all([
        loadRegionalReportingData(supabase),
        loadIncidentEvidenceForIncidents(supabase, refreshed.map((incident) => incident.id)).catch(() => []),
      ]);
      if (sessionUserIdRef.current !== requestingUserId) return;
      setIncidents(refreshed);
      setWeeklyIssueRates(reporting.rates);
      setReportIncidents(reporting.incidents);
      setReportEvidence(combineIncidentEvidence(reporting.evidence, incidentEvidence));
      setLastIncidentSyncAt(new Date());
      setIncidentError('');
    } catch (error) {
      if (sessionUserIdRef.current === requestingUserId) {
        setAnalysisError(error instanceof Error ? error.message : 'A separate incident could not be saved.');
      }
    } finally {
      if (sessionUserIdRef.current === requestingUserId) setIsSavingIncident(false);
    }
  };

  const exportCsv = () => {
    const headers = ['ID', 'Feedback', 'Source', 'Store', 'Region', 'Category', 'Severity', 'Assigned team', 'Recommended action', 'Status', 'Received'];
    const rows = visibleFeedback.map((item) => [
      item.id,
      item.text,
      item.source,
      item.store,
      item.location,
      item.category,
      item.severity,
      item.assignedDepartment,
      item.recommendedAction,
      item.status,
      item.received,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const file = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = dataView === 'live'
      ? 'voice-of-store-incidents.csv'
      : dataView === 'local'
        ? 'voice-of-store-local-incidents.csv'
        : 'voice-of-store-r5-benchmark-feedback.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadTrendCsv = () => {
    const headers = ['Period', 'Critical', 'High', 'Medium', 'Low', 'Unclassified', 'Total'];
    const rows = visibleTrend.map((point) => [
      point.day,
      point.critical,
      point.high,
      point.medium,
      point.low,
      'unclassified' in point ? point.unclassified : 0,
      point.critical + point.high + point.medium + point.low + ('unclassified' in point ? point.unclassified : 0),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const file = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voice-of-store-${dataView}-trend.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadTransactionTemplate = () => {
    const file = new Blob(['store_id,week_index,total_transactions\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'store_weekly_transactions_template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const markDuplicateReview = (candidate: DuplicateCandidate, review: DuplicateReview) => {
    if (supabase && session?.user.id) {
      const client = supabase;
      const reviewerId = session.user.id;
      const currentVote = duplicateReviewStatus[candidate.candidate_id]?.myDecision ?? null;
      const nextVote = currentVote === review ? null : review;
      setDuplicateReviewSavingId(candidate.candidate_id);
      setDuplicateReviewSyncError('');
      void saveDuplicateReviewVote(
        client,
        reviewerId,
        {
          candidate_id: candidate.candidate_id,
          feedback_ids: candidate.records.map((record) => record.feedback_id),
          store_id: candidate.store_id,
          week_index: candidate.week_index,
          issue_type_ids: candidate.issue_type_ids,
          match_type: candidate.match_type,
          similarity: candidate.similarity,
        },
        nextVote,
      )
        .then(() => loadDuplicateReviewVotes(client))
        .then((votes) => setDuplicateReviewVotes(votes))
        .catch((error: unknown) => {
          setDuplicateReviewSyncError(error instanceof Error
            ? `Could not save shared review: ${error.message}`
            : 'Could not save shared review. Check the database migration and your sign-in.');
        })
        .finally(() => setDuplicateReviewSavingId(''));
      return;
    }
    setDuplicateReviews((current) => {
      const next = { ...current };
      if (next[candidate.candidate_id] === review) delete next[candidate.candidate_id];
      else next[candidate.candidate_id] = review;
      return next;
    });
  };

  const downloadDuplicateReviewCsv = () => {
    if (!duplicateQueue) return;
    const rows = duplicateQueue.candidates.map((candidate) => [
      candidate.candidate_id,
      candidate.match_type,
      candidate.similarity,
      candidate.store_id,
      candidate.store_name,
      candidate.region,
      candidate.week_index,
      candidate.issue_type_ids.join('; '),
      candidate.records.map((record) => record.feedback_id).join('; '),
      candidate.records.map((record) => record.channel).join('; '),
      candidate.records.map((record) => record.text).join(' | '),
      sharedDuplicateReviewMode
        ? duplicateReviewStatus[candidate.candidate_id]?.consensus ?? 'pending'
        : duplicateReviews[candidate.candidate_id] ?? 'pending',
    ]);
    const headers = ['candidate_id', 'match_type', 'text_similarity', 'store_id', 'store_name', 'region', 'week_index', 'predicted_issue_type_ids', 'feedback_ids', 'channels', 'source_texts', 'human_review'];
    const csv = [headers, ...rows]
      .map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const file = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'voice-of-store-duplicate-review.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadBenchmarkBrief = () => {
    const report = displayedBenchmarkBrief;
    if (!report) return;
    const lines = [
      `# Voice-of-Store weekly action brief · ${report.region}`,
      `Week ${report.week_index} · ${report.week_start} to ${report.week_end}`,
      '',
      `Feedback rows: ${report.feedback_rows} · confirmed duplicates collapsed: ${report.confirmed_deduplicated_reports} · Store coverage: ${report.covered_store_count}/${report.expected_store_count}`,
      report.previous_week_index === null
        ? 'No prior calendar week is available for comparison.'
        : report.previous_week_available
          ? `Compared with Week ${report.previous_week_index} · ${report.previous_week_feedback_rows} regional feedback rows.`
          : `Week ${report.previous_week_index} has no regional feedback rows; trend comparison is unavailable.`,
      report.normalization_note,
      '',
      '## Emerging detector flags',
      ...(report.emerging_issues.length
        ? report.emerging_issues.map((issue) => `- ${issue.category} · ${issue.flag_count} store-week flags · ${issue.flagged_stores.join(', ')} · ${issue.evidence_count} linked feedback records`)
        : ['No evidence-backed generated flags are available for this region and week.']),
      '',
      ...report.issues.flatMap((issue, index) => [
        `## ${index + 1}. ${issue.category} · ${issue.severity}`,
        `Responsible department: ${issue.responsible_department} · ${issue.feedback_count} classified feedback rows · ${issue.affected_stores.join(', ') || 'No stores listed'}`,
        `Trend: ${weeklyRateComparisonLabel(issue.normalized_rate_per_1000_exposure, issue.previous_rate_per_1000_exposure, issue.trend, issue.normalization_source === 'transactions' ? 'transactions' : 'average weekly footfall')} · Predicted actionable share: ${(issue.actionable_share * 100).toFixed(1)}%`,
        `Rate source: ${issue.normalization_source} · Rate uses ${issue.rate_feedback_count} feedback rows across ${issue.rate_store_coverage} stores`,
        ...(issue.emerging_flag_count ? [`Emerging flags: ${issue.emerging_flag_count} · ${issue.emerging_stores.join(', ')}`] : []),
        `Recommended action: ${issue.recommended_action}`,
        ...issue.quotes.map((quote) => `> “${quote.text}” — ${quote.store_name}, ${quote.source} (${quote.feedback_id})`),
        '',
      ]),
      `Public temporal holdout only (${report.validation_precision.rows} rows): actionable precision ${(report.validation_precision.actionable_precision * 100).toFixed(1)}%; high/critical actionable precision ${(report.validation_precision.actionable_high_or_critical_precision * 100).toFixed(1)}%. These are global holdout metrics, not regional precision.`,
    ];
    const file = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voice-of-store-${report.region.toLowerCase()}-week-${report.week_index}-brief.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const routeDecision = authRouteDecision(currentPath, isCheckingSession, Boolean(session));
  if (routeDecision === 'loading' || routeDecision === 'redirect-login' || routeDecision === 'redirect-dashboard') {
    return (
      <main className="auth-loading" aria-live="polite" aria-busy="true">
        <span className="auth-loading-mark"><Store size={20} /></span>
        <strong>{isCheckingSession ? 'Checking your secure session…' : 'Opening your workspace…'}</strong>
      </main>
    );
  }
  if (routeDecision === 'login') {
    return (
      <AuthScreen
        configured={supabaseConfigured}
        busy={isAuthenticating || isGoogleSigningIn}
        error={authError || sessionRestoreError}
        notice={authNotice}
        googleBusy={isGoogleSigningIn}
        onGoogleSignIn={handleGoogleSignIn}
        onSubmit={handleAuth}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Voice of Store overview">
          <span className="brand-mark"><Store size={20} strokeWidth={2.2} /></span>
          <span className="brand-copy">
            <strong>voice of store</strong>
            <small>OPERATIONS INTELLIGENCE</small>
          </span>
        </a>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Primary navigation">
          <a className={`nav-item ${activeNav === 'overview' ? 'active' : ''}`} href="#overview" onClick={() => setActiveNav('overview')}><LayoutDashboard size={17} /><span>Overview</span>{activeNav === 'overview' && <span className="nav-active-dot" />}</a>
          <a className={`nav-item ${activeNav === 'feedback' ? 'active' : ''}`} href="#feedback" onClick={() => setActiveNav('feedback')}><MessageSquareText size={17} /><span>Feedback</span><span className="nav-count">{dataView === 'live' ? incidents.length : dataView === 'local' ? localIncidents.length : benchmarkData?.summary.feedback_records.toLocaleString() ?? '—'}</span></a>
          <a className={`nav-item ${activeNav === 'alerts' ? 'active' : ''}`} href={dataView === 'demo' ? '#emerging-alerts' : dataView === 'live' ? '#live-alerts' : '#feedback'} onClick={() => setActiveNav('alerts')}><ShieldAlert size={17} /><span>Incidents &amp; alerts</span><span className="nav-count alert">{notificationCount}</span></a>
          <a className={`nav-item ${activeNav === 'stores' ? 'active' : ''}`} href="#store-impact" onClick={() => setActiveNav('stores')}><Store size={17} /><span>Stores</span></a>
          <a className={`nav-item ${activeNav === 'solution' ? 'active' : ''}`} href="#solution-design" onClick={() => setActiveNav('solution')}><Workflow size={17} /><span>How it works</span></a>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-callout">
            <div className="callout-icon"><Sparkles size={15} /></div>
            <div>
              <strong>{dataView === 'live' ? 'Secure workspace' : dataView === 'local' ? 'Local prototype' : 'Public benchmark'}</strong>
              <span>{dataView === 'live' ? 'Authorized incident data' : dataView === 'local' ? 'Browser-only incident data' : benchmarkData ? 'Organizer R5 records and predictions' : benchmarkError || 'Loading public data'}</span>
            </div>
          </div>
          <div className="profile-row">
            <div className="avatar">{session ? (session.user.email?.slice(0, 1).toUpperCase() ?? 'U') : 'OP'}</div>
            <div className="profile-copy"><strong>{session?.user.email ?? 'Operations team'}</strong><span>{session ? `${memberships.length} authorized store${memberships.length === 1 ? '' : 's'}` : 'Store network · demo'}</span></div>
            <span className="online-dot" title={session ? 'Authenticated' : 'Demo mode'} />
          </div>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="topbar">
          <a className="mobile-brand" href="#overview"><span className="brand-mark"><Store size={18} /></span><strong>voice of store</strong></a>
          <div className="breadcrumbs"><span>Operations</span><span className="breadcrumb-slash">/</span><strong>Overview</strong></div>
          <div className="topbar-actions">
            <span className={`demo-pill ${dataView === 'live' ? 'live-pill' : ''}`}><span className="demo-dot" />{dataView === 'live' ? 'AUTHORIZED LIVE DATA' : dataView === 'local' ? 'LOCAL PROTOTYPE · BROWSER ONLY' : 'PUBLIC R5 BENCHMARK'}</span>
            <div className="notification-control">
              <button className="icon-button notification-button" aria-label={`Attention queue, ${notificationCount} items`} aria-expanded={notificationsOpen} aria-controls="notification-panel" onClick={() => setNotificationsOpen((open) => !open)} type="button">
                <Bell size={18} />
                {notificationCount > 0 && <span className="notification-count">{notificationCount > 99 ? '99+' : notificationCount}</span>}
              </button>
              {notificationsOpen && (
                <div className="notification-popover" id="notification-panel" role="dialog" aria-label="Attention queue">
                  <div className="notification-popover-heading"><strong>Attention queue</strong><span>{notificationCount} {dataView === 'demo' ? 'generated flags' : 'open incidents'}</span></div>
                  <div className="notification-list">
                    {dataView === 'demo'
                      ? benchmarkData?.alerts.slice(0, 4).map((alert) => (
                        <a className="notification-item" href="#emerging-alerts" onClick={() => setNotificationsOpen(false)} key={`${alert.week_start}-${alert.store_id}-${alert.issue_type_id}`}>
                          <strong>{alert.category}</strong><span>{alert.store_name} · {alert.region}</span><small>{alert.evidence_count} linked reports · {alert.severity} priority</small>
                        </a>
                      ))
                      : openIncidents.slice(0, 4).map((incident) => (
                        <a className="notification-item" href="#feedback" onClick={() => setNotificationsOpen(false)} key={incident.id}>
                          <strong>{incident.category}</strong><span>{incident.store?.name ?? 'Store not listed'} · {incident.status}</span><small>{incident.severity} priority · {incident.assigned_department}</small>
                        </a>
                      ))}
                    {dataView === 'demo' && benchmarkLoading && <p className="notification-empty">Loading public detector flags…</p>}
                    {dataView === 'demo' && !benchmarkLoading && !benchmarkData?.alerts.length && <p className="notification-empty">No evidence-backed flags are available.</p>}
                    {dataView !== 'demo' && openIncidents.length === 0 && <p className="notification-empty">No open incidents need review.</p>}
                  </div>
                  <a className="notification-footer-link" href={dataView === 'demo' ? '#emerging-alerts' : '#feedback'} onClick={() => setNotificationsOpen(false)}>{dataView === 'demo' ? 'Review detector flags' : 'Open incident register'} <ArrowRight size={13} /></a>
                </div>
              )}
            </div>
            <div className="top-avatar" aria-label={session?.user.email ?? 'Operations team'}>{session ? (session.user.email?.slice(0, 1).toUpperCase() ?? 'U') : 'OP'}</div>
            {authError && <span className="topbar-auth-error" role="alert">{authError}</span>}
            {session ? (
              <button className="button button-sign-out" onClick={() => void handleSignOut()} type="button" disabled={isSigningOut}>
                <LogOut size={15} />{isSigningOut ? 'Signing out…' : 'Sign out'}
              </button>
            ) : <a className="button button-sign-out" href="/login">Sign in</a>}
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> STORE EXPERIENCE PULSE</div>
              <h1>Store voice, <span>made actionable.</span></h1>
              <p>See what customers and teams are telling you, then focus attention where it matters.</p>
            </div>
            <div className="heading-actions">
              <span className="button button-date date-range-label"><CalendarDays size={16} /><span>{dataView === 'live' ? 'Live · 14 days' : dataView === 'local' ? 'Local · saved records' : benchmarkData ? `Benchmark · ${benchmarkData.summary.weeks} weeks` : 'R5 benchmark'}</span></span>
              <a className="button button-outline" href="#solution-design" onClick={() => setActiveNav('solution')}><Workflow size={15} /><span>How it works</span></a>
              <ExportButton onClick={exportCsv} />
            </div>
          </section>

          <section className={`demo-banner ${dataView !== 'demo' ? 'live-data-banner' : ''}`} aria-label="Dashboard data source">
            <div className="demo-banner-icon"><Sparkles size={17} /></div>
            <div className="demo-banner-copy"><strong>{dataView === 'live' ? 'Authorized incident register' : dataView === 'local' ? 'Local browser incident register' : benchmarkData ? 'Organizer-provided synthetic R5 benchmark' : 'R5 benchmark connection'}</strong><span>{dataView === 'live' ? 'Records are scoped to stores granted to your signed-in account. Live summaries use saved incidents; classifier output does not dispatch external alerts.' : dataView === 'local' ? 'These records and status changes stay in this browser and are not synced to Supabase or sent to store teams.' : benchmarkData ? `${benchmarkData.summary.feedback_records.toLocaleString()} feedback rows · ${benchmarkData.summary.prediction_records.toLocaleString()} predictions · ${benchmarkData.summary.stores} stores · ${benchmarkData.summary.taxonomy_categories} official categories. Fictional benchmark data, not live customer data.` : benchmarkLoading ? 'Loading official organizer records and generated outputs from FastAPI.' : benchmarkError}</span></div>
            <div className="data-mode-switch" role="group" aria-label="Dashboard data source">
              <button className={dataView === 'demo' ? 'selected' : ''} type="button" onClick={() => setDataView('demo')}>R5 benchmark</button>
              <button className={dataView === 'local' ? 'selected' : ''} type="button" onClick={() => setDataView('local')}>Local ({localIncidents.length})</button>
              <button className={dataView === 'live' ? 'selected' : ''} type="button" disabled={!supabaseConfigured || !session} onClick={() => setDataView('live')}>Live{isLoadingIncidents ? '…' : ` (${incidents.length})`}</button>
            </div>
          </section>

          <section className="metrics-grid" id="store-impact" aria-label="Summary metrics">
            {displayedMetrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
          </section>

          <section className="charts-grid" aria-label="Incident analytics">
            <article className="panel chart-panel" id="incident-trends">
              <div className="panel-heading">
                <div>
                  <div className="panel-kicker"><span className="panel-kicker-dot" /> SIGNAL MOVEMENT</div>
                  <h2>Incident trend</h2>
                  <p>{dataView === 'demo' ? `Organizer predictions · ${trendWindow === 'recent' ? `${visibleTrend.length} most recent weeks` : 'all available weeks'}` : `Saved reports · ${trendWindow === 'recent' ? `${visibleTrend.length} most recent days` : 'all available days'}`}</p>
                </div>
                <div className="trend-options-wrap">
                  <button className="icon-button more-button" aria-label="Incident trend options" aria-expanded={trendMenuOpen} aria-controls="trend-options-menu" onClick={() => setTrendMenuOpen((open) => !open)} type="button"><span>···</span></button>
                  {trendMenuOpen && (
                    <div className="trend-options-menu" id="trend-options-menu" role="group" aria-label="Trend chart options">
                      <span className="trend-menu-label">TIME RANGE</span>
                      <button className={trendWindow === 'recent' ? 'selected' : ''} aria-pressed={trendWindow === 'recent'} onClick={() => { setTrendWindow('recent'); setTrendMenuOpen(false); }} type="button">Last 8 periods</button>
                      <button className={trendWindow === 'all' ? 'selected' : ''} aria-pressed={trendWindow === 'all'} onClick={() => { setTrendWindow('all'); setTrendMenuOpen(false); }} type="button">All available</button>
                      <button onClick={() => { downloadTrendCsv(); setTrendMenuOpen(false); }} type="button"><Download size={13} /> Download chart CSV</button>
                      <a href={dataView === 'demo' ? '#weekly-brief' : dataView === 'live' ? '#live-weekly-brief' : '#feedback'} onClick={() => { setTrendMenuOpen(false); setActiveNav(dataView === 'local' ? 'feedback' : 'alerts'); }}>{dataView === 'local' ? 'Open local register' : 'Open weekly brief'} <ArrowRight size={13} /></a>
                    </div>
                  )}
                </div>
              </div>
              <div className="chart-summary-row">
                <div><strong>{dataView === 'demo' ? benchmarkData?.trend.at(-1)?.total.toLocaleString() ?? '—' : activeLastSevenTotal}</strong><span>{dataView === 'demo' ? 'classified feedback · latest week' : dataView === 'local' ? 'local incidents · last 7 days' : 'incident reports · last 7 days'}</span></div>
              </div>
              <div className="chart-area trend-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={visibleTrend} margin={{ top: 8, right: 6, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="criticalFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e66d62" stopOpacity={0.25} /><stop offset="95%" stopColor="#e66d62" stopOpacity={0.02} /></linearGradient>
                      <linearGradient id="highFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#edaa64" stopOpacity={0.2} /><stop offset="95%" stopColor="#edaa64" stopOpacity={0.02} /></linearGradient>
                      <linearGradient id="mediumFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#749b8e" stopOpacity={0.18} /><stop offset="95%" stopColor="#749b8e" stopOpacity={0.02} /></linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#edf0f4" strokeDasharray="4 5" />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#97a1b2', fontSize: 11 }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#97a1b2', fontSize: 11 }} />
                    <Tooltip contentStyle={{ border: '1px solid #e8edf2', borderRadius: 12, boxShadow: '0 8px 24px rgba(27, 39, 61, .08)' }} />
                    <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11, color: '#667085', paddingTop: 8 }} />
                    <Area type="monotone" dataKey="critical" name="Critical" stackId="1" stroke="#df6d62" fill="url(#criticalFill)" strokeWidth={2} />
                    <Area type="monotone" dataKey="high" name="High" stackId="1" stroke="#eaaa65" fill="url(#highFill)" strokeWidth={2} />
                    <Area type="monotone" dataKey="medium" name="Medium" stackId="1" stroke="#749b8e" fill="url(#mediumFill)" strokeWidth={2} />
                    <Area type="monotone" dataKey="low" name="Low" stackId="1" stroke="#b9c2d0" fill="#d8dee8" fillOpacity={0.35} strokeWidth={2} />
                    {dataView !== 'demo' && <Area type="monotone" dataKey="unclassified" name="Unclassified" stackId="1" stroke="#9aa3b0" fill="#cbd1d9" fillOpacity={0.35} strokeWidth={2} />}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-footnote"><span className="footnote-marker" />{dataView === 'live' ? 'Counts come from saved incidents in stores authorized for your account.' : dataView === 'local' ? 'Counts use records saved in this browser only.' : 'Counts use the complete organizer feedback package and generated R5 prediction file.'}</div>
            </article>

            <article className="panel chart-panel category-panel">
              <div className="panel-heading">
                <div>
                  <div className="panel-kicker"><span className="panel-kicker-dot peach" /> WHAT STORES ARE HEARING</div>
                  <h2>Top feedback themes</h2>
                  <p>{dataView === 'live' ? 'Most reported categories in the last seven days' : dataView === 'local' ? 'Categories from local browser records' : 'Most common predicted categories across all benchmark weeks'}</p>
                </div>
                <a className="text-link" href="#feedback">View feedback <ArrowRight size={14} /></a>
              </div>
              <div className="chart-summary-row category-summary">
                <div><strong>{dataView === 'demo' ? activeCategorySignals.reduce((total, item) => total + item.count, 0).toLocaleString() : activeLastSevenTotal}</strong><span>{dataView === 'demo' ? 'signals in categories shown' : 'total category signals'}</span></div>
                <span className="summary-caption">{activeCategorySignals.length} themes</span>
              </div>
              <div className="chart-area category-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={activeCategorySignals} layout="vertical" margin={{ top: 0, right: 16, left: 4, bottom: 0 }}>
                    <CartesianGrid horizontal={false} stroke="#edf0f4" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#97a1b2', fontSize: 11 }} />
                    <YAxis type="category" dataKey="shortLabel" axisLine={false} tickLine={false} width={76} tick={{ fill: '#667085', fontSize: 11 }} />
                    <Tooltip cursor={{ fill: '#f6f8fb' }} contentStyle={{ border: '1px solid #e8edf2', borderRadius: 12, boxShadow: '0 8px 24px rgba(27, 39, 61, .08)' }} />
                    <Bar dataKey="count" name="Reports" fill="#4a8f84" radius={[0, 6, 6, 0]} barSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-footnote"><span className="footnote-marker peach" />{dataView === 'live' ? 'Category counts use saved, authorized incidents only.' : dataView === 'local' ? 'Category counts use local browser records only.' : 'Category counts come from the full public prediction output and official taxonomy.'}</div>
            </article>
          </section>

          {dataView === 'demo' && benchmarkData && (
            <>
              <section className="report-grid benchmark-report-grid" id="emerging-alerts" aria-label="R5 evidence-backed emerging alerts and weekly report">
                <article className="panel report-panel benchmark-alert-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="panel-kicker"><span className="panel-kicker-dot peach" /> CAUSAL STORE-WEEK DETECTOR</div>
                      <h2>Emerging issue flags</h2>
                      <p>{benchmarkData.summary.emerging_flag_rows} generated flags · {benchmarkData.summary.valid_evidence_ids} evidence references validated by the local submission check</p>
                    </div>
                  </div>
                  <p className="report-rule">Flags use only feedback visible by each week’s end, store-specific history, and average weekly footfall as a proxy because transaction totals are not in the package. Scores are detector heuristics, not calibrated probabilities.</p>
                  {benchmarkData.alerts.length > 0 ? (
                    <div className="benchmark-alert-list">
                      {benchmarkData.alerts.map((alert) => (
                        <article className="benchmark-alert-card" key={`${alert.week_start}-${alert.store_id}-${alert.issue_type_id}`}>
                          <div className="benchmark-alert-heading">
                            <div><strong>{alert.category}</strong><span>{alert.store_name} · {alert.region} · {new Date(`${alert.week_start}T00:00:00`).toLocaleDateString()}</span></div>
                            <span className={`severity-badge ${alert.severity.toLowerCase()}`}><i />{alert.severity}</span>
                          </div>
                          <div className="benchmark-alert-meta"><span>Owner: {alert.owner_function}</span><span>Store ID: {alert.store_id}</span><span>Detector score: {alert.detector_score.toFixed(2)}</span><span>Rate: {alert.current_rate_per_1000_footfall === null ? 'unavailable' : `${alert.current_rate_per_1000_footfall.toFixed(3)} per 1k`}</span><span>Four-week mean: {alert.rolling_mean_per_1000_footfall === null ? 'unavailable' : `${alert.rolling_mean_per_1000_footfall.toFixed(3)} per 1k`}</span><span>EWMA: {alert.ewma_baseline_per_1000_footfall === null ? 'unavailable' : `${alert.ewma_baseline_per_1000_footfall.toFixed(3)} per 1k`} · z-score {alert.ewma_z_score === null ? 'unavailable' : alert.ewma_z_score.toFixed(2)}</span><span>{alert.evidence_count} source reports</span><span>Feedback IDs: {alert.evidence_feedback_ids.join(', ')}</span></div>
                          {alert.matches_public_incident_example && <p className="benchmark-incident-note">Public incident example: first matching flag is the same week as the naive baseline; measured lead is zero weeks.</p>}
                          {alert.evidence.map((evidence) => <blockquote key={evidence.feedback_id}>&ldquo;{evidence.text}&rdquo; <cite>— {evidence.store_name} · {sourceLabel(evidence.channel)} · {evidence.feedback_id}</cite></blockquote>)}
                        </article>
                      ))}
                    </div>
                  ) : <div className="report-empty">No generated evidence-backed flags are available in the current public output.</div>}
                </article>

                <article className="panel report-panel duplicate-review-panel" id="duplicate-review">
                  <div className="panel-heading">
                    <div>
                      <div className="panel-kicker"><span className="panel-kicker-dot green" /> CROSS-CHANNEL REVIEW</div>
                      <h2>Possible duplicate reports</h2>
                      <p>Review same-store reports from different channels before grouping an incident</p>
                    </div>
                    <button className="button button-secondary" type="button" onClick={downloadDuplicateReviewCsv} disabled={!duplicateQueue?.candidates.length}><Download size={15} /> Export review</button>
                  </div>
                  {duplicateQueue && <div className="duplicate-queue-summary"><strong>{duplicateQueue.summary.candidate_count} candidates</strong><span>{duplicateQueue.summary.exact_text_groups} exact text groups · {duplicateQueue.summary.near_text_pairs} near-text pairs · {duplicateQueue.summary.scanned_feedback_records.toLocaleString()} scoped records scanned</span><span>{duplicateQueue.scope}</span><span>{duplicateQueue.candidates.filter((item) => sharedDuplicateReviewMode ? Boolean(duplicateReviewStatus[item.candidate_id]?.same || duplicateReviewStatus[item.candidate_id]?.separate) : Boolean(duplicateReviews[item.candidate_id])).length} of {duplicateQueue.candidates.length} shown reviewed · {sharedDuplicateReviewMode ? 'shared Supabase votes' : 'this browser only; sign in to share reviews'}</span><span>Confirming “same incident” updates the regional brief counts and rates for matching issue types.</span></div>}
                  {duplicateQueueError && <div className="table-error" role="alert">{duplicateQueueError}</div>}
                  {duplicateReviewLoading && <div className="report-empty">Loading shared duplicate-review decisions…</div>}
                  {duplicateReviewSyncError && <div className="table-error" role="alert">{duplicateReviewSyncError}</div>}
                  {duplicateQueueLoading && <div className="report-empty">Scanning the public feedback for cross-channel text matches…</div>}
                  {!duplicateQueueLoading && duplicateQueue && (
                    <>
                      <p className="report-rule">{duplicateQueue.method_note}</p>
                      {duplicateQueue.candidates.length ? (
                        <div className="duplicate-candidate-list">
                          {duplicateQueue.candidates.map((candidate) => {
                            const sharedStatus = duplicateReviewStatus[candidate.candidate_id];
                            const myReview = sharedDuplicateReviewMode ? sharedStatus?.myDecision ?? undefined : duplicateReviews[candidate.candidate_id];
                            const review = sharedDuplicateReviewMode ? sharedStatus?.consensus ?? undefined : myReview;
                            const isSaving = duplicateReviewSavingId === candidate.candidate_id;
                            return (
                              <article className="duplicate-candidate-card" key={candidate.candidate_id}>
                                <div className="benchmark-alert-heading">
                                  <div><strong>{candidate.category}</strong><span>{candidate.store_name} · {candidate.region} · Week {candidate.week_index} · {candidate.channels.map(sourceLabel).join(' + ')}</span></div>
                                  <span className="duplicate-match-badge">{candidate.match_type === 'exact_text' ? 'Exact text' : `Text similarity ${candidate.similarity.toFixed(2)}`}</span>
                                </div>
                                {candidate.issue_match ? <div className="benchmark-alert-meta"><span>Same predicted issue: {candidate.issue_type_ids.join(', ')}</span></div> : <p className="duplicate-review-warning">The model assigned different issue types; check the reports before deciding.</p>}
                                {candidate.records.map((record) => <blockquote key={record.feedback_id}>&ldquo;{record.text}&rdquo; <cite>— {record.store_name} · {sourceLabel(record.channel)} · {record.feedback_id}</cite></blockquote>)}
                                <div className="duplicate-review-actions">
                                  <button className={`button button-secondary ${myReview === 'same' ? 'selected-review' : ''}`} type="button" aria-pressed={myReview === 'same'} disabled={duplicateReviewLoading || isSaving} onClick={() => markDuplicateReview(candidate, 'same')}><Check size={14} /> Same incident</button>
                                  <button className={`button button-secondary ${myReview === 'separate' ? 'selected-review' : ''}`} type="button" aria-pressed={myReview === 'separate'} disabled={duplicateReviewLoading || isSaving} onClick={() => markDuplicateReview(candidate, 'separate')}><X size={14} /> Keep separate</button>
                                  <span>{sharedDuplicateReviewMode
                                    ? `${review ? `Shared result: ${review === 'same' ? 'same incident' : 'separate reports'}` : 'Needs review'} · ${sharedStatus?.same ?? 0} same / ${sharedStatus?.separate ?? 0} separate votes${myReview ? ` · your vote: ${myReview}` : ''}`
                                    : review ? `Your local review: ${review === 'same' ? 'same incident' : 'separate reports'}` : 'Needs human review'}</span>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      ) : <div className="report-empty">No cross-channel duplicate candidates passed the review filters.</div>}
                    </>
                  )}
                </article>

                <article className="panel report-panel benchmark-brief-panel" id="weekly-brief">
                  <div className="panel-heading">
                    <div>
                      <div className="panel-kicker"><span className="panel-kicker-dot green" /> WEEKLY REGIONAL OPERATIONS BRIEF</div>
                      <h2>Top issues and recommended follow-up</h2>
                      <p>Organizer feedback, R5 predictions, generated emerging flags, and linked source quotes</p>
                    </div>
                  </div>
                  <div className="benchmark-brief-filters">
                    <label className="region-picker"><span>Region</span><select aria-label="Choose benchmark region" value={selectedBenchmarkRegion} onChange={(event) => setSelectedBenchmarkRegion(event.target.value)}>{benchmarkData.summary.regions.map((region) => <option key={region}>{region}</option>)}</select></label>
                    <label className="region-picker"><span>Week</span><select aria-label="Choose benchmark week" value={selectedBenchmarkWeek || ''} onChange={(event) => setSelectedBenchmarkWeek(Number(event.target.value))}>{benchmarkData.trend.map((week) => <option key={week.week_index} value={week.week_index}>Week {week.week_index} · {week.week_start}</option>)}</select></label>
                    <button className="button button-secondary" type="button" onClick={downloadBenchmarkBrief} disabled={!displayedBenchmarkBrief}><Download size={15} /> Download brief</button>
                    <button className="button button-secondary" type="button" onClick={downloadTransactionTemplate}><Download size={15} /> Transaction template</button>
                  </div>
                  {benchmarkBriefError && <div className="table-error" role="alert">{benchmarkBriefError}</div>}
                  {benchmarkBriefLoading && <div className="report-empty">Building the regional brief from source feedback…</div>}
                  {displayedBenchmarkBrief && !benchmarkBriefLoading && (
                    <>
                      <div className="benchmark-brief-summary"><strong>{displayedBenchmarkBrief.region} · {displayedBenchmarkBrief.week_start} to {displayedBenchmarkBrief.week_end}</strong><span>{displayedBenchmarkBrief.feedback_rows.toLocaleString()} classified reports · {displayedBenchmarkBrief.confirmed_deduplicated_reports} confirmed duplicates collapsed · denominator coverage {displayedBenchmarkBrief.covered_store_count}/{displayedBenchmarkBrief.expected_store_count} stores · {displayedBenchmarkBrief.normalization_source === 'transactions' ? 'transaction totals' : 'footfall estimate'}</span><span>{displayedBenchmarkBrief.previous_week_index === null ? 'No prior calendar week is available.' : displayedBenchmarkBrief.previous_week_available ? `Week ${displayedBenchmarkBrief.previous_week_index} comparison uses ${displayedBenchmarkBrief.previous_week_feedback_rows.toLocaleString()} regional feedback rows.` : `Week ${displayedBenchmarkBrief.previous_week_index} has no regional feedback rows; comparison is unavailable.`}</span></div>
                      {displayedBenchmarkBrief.empty_period_message ? <div className="report-empty">{displayedBenchmarkBrief.empty_period_message}</div> : (
                        <>
                          <div className="brief-emerging-panel">
                            <strong>Emerging issues from the generated detector</strong>
                            {displayedBenchmarkBrief.emerging_issues.length ? displayedBenchmarkBrief.emerging_issues.map((issue) => (
                              <article className="brief-emerging-item" key={issue.issue_type_id}>
                                <div><b>{issue.category}</b><span>{issue.flag_count} flags · {issue.flagged_stores.join(', ')}</span></div>
                                <span>Responsible department: {issue.responsible_department} · {issue.evidence_count} linked feedback records</span>
                                {issue.quotes.slice(0, 1).map((quote) => <blockquote key={quote.feedback_id}>&ldquo;{quote.text}&rdquo; <cite>— {quote.store_name} · {sourceLabel(quote.channel)} · {quote.feedback_id}</cite></blockquote>)}
                              </article>
                            )) : <div className="report-empty">No evidence-backed generated flags are available for this region and week.</div>}
                          </div>
                          <div className="benchmark-issue-list">
                            {displayedBenchmarkBrief.issues.map((issue, index) => (
                              <article className="benchmark-issue-card" key={issue.issue_type_id}>
                                <div className="benchmark-alert-heading">
                                  <div><strong>{index + 1}. {issue.category} · {issue.issue_type_id}</strong><span>{issue.feedback_count} classified feedback rows · Affected stores: {issue.affected_stores.join(', ') || 'Not listed'}</span></div>
                                  <span className={`severity-badge ${issue.severity.toLowerCase()}`}><i />{issue.severity}</span>
                                </div>
                                <div className="benchmark-alert-meta"><span>Responsible department: {issue.responsible_department}</span><span>{weeklyRateComparisonLabel(issue.normalized_rate_per_1000_exposure, issue.previous_rate_per_1000_exposure, issue.trend, issue.normalization_source === 'transactions' ? 'transactions' : 'average weekly footfall')}</span><span>Rate uses {issue.rate_feedback_count} reports across {issue.rate_store_coverage} stores</span><span>{issue.previous_feedback_count === null ? 'Previous-week count unavailable' : `${issue.previous_feedback_count} feedback rows in previous week`}</span><span>{(issue.actionable_share * 100).toFixed(0)}% predicted actionable</span>{issue.emerging_flag_count > 0 && <span>Emerging flag · {issue.emerging_flag_count} · {issue.emerging_stores.join(', ')}</span>}</div>
                                <p className="report-rule">Recommended action: {issue.recommended_action}</p>
                                {issue.quotes.slice(0, 2).map((quote) => <blockquote key={quote.feedback_id}>&ldquo;{quote.text}&rdquo; <cite>— {quote.store_name} · {sourceLabel(quote.source)} · {quote.feedback_id}</cite></blockquote>)}
                              </article>
                            ))}
                          </div>
                        </>
                      )}
                      <p className="report-rule">{displayedBenchmarkBrief.normalization_note} Holdout precision is global across the validation period; it is not measured per region or week. {benchmarkData.summary.transaction_rows_loaded === 0 ? 'No transaction totals are installed. Download the template, fill it with verified store/week counts, save it as data/store_weekly_transactions.csv (or set VOS_R5_TRANSACTIONS_CSV), and restart FastAPI.' : `${benchmarkData.summary.transaction_rows_loaded} verified store/week transaction rows are loaded for ${benchmarkData.summary.transaction_weeks_loaded} weeks.`} Confirmed local duplicate reviews are reflected in the report; generated detector flags remain based on the original public output.</p>
                    </>
                  )}
                </article>
              </section>

              <section className="panel evaluation-panel" id="evaluation" aria-label="R5 evaluation results and limitations">
                <div className="panel-heading"><div><div className="panel-kicker"><span className="panel-kicker-dot peach" /> MEASURED RESULTS</div><h2>Evaluation and limits</h2><p>Chronological holdout and official public evaluation are shown separately.</p></div></div>
                <div className="evaluation-grid">
                  <article className="evaluation-card"><strong>Chronological validation</strong><span>{benchmarkData.metrics.holdout.rows} rows · weeks 10–13 · {benchmarkData.metrics.holdout.issue_type_classes} classes</span><dl><div><dt>Issue macro F1</dt><dd>{benchmarkData.metrics.holdout.issue_type_macro_f1.toFixed(3)}</dd></div><div><dt>Severity weighted F1</dt><dd>{benchmarkData.metrics.holdout.severity_weighted_f1.toFixed(3)}</dd></div><div><dt>Actionable precision</dt><dd>{(benchmarkData.metrics.holdout.actionable_precision * 100).toFixed(1)}%</dd></div><div><dt>High/critical actionable precision</dt><dd>{(benchmarkData.metrics.holdout.actionable_high_or_critical_precision * 100).toFixed(1)}%</dd></div></dl></article>
                  <article className="evaluation-card"><strong>Official public evaluator</strong><span>{benchmarkData.metrics.public_evaluator.rows.toLocaleString()} labeled rows · public diagnostic only</span><dl><div><dt>Classification score</dt><dd>{benchmarkData.metrics.public_evaluator.classification_score.toFixed(3)}</dd></div><div><dt>Lead score</dt><dd>{benchmarkData.metrics.public_evaluator.lead_score.toFixed(3)}</dd></div><div><dt>Primary score</dt><dd>{benchmarkData.metrics.public_evaluator.primary_score.toFixed(3)}</dd></div><div><dt>Valid public flags</dt><dd>{benchmarkData.metrics.public_evaluator.valid_flags}/{benchmarkData.metrics.public_evaluator.flags_in_scored_period}</dd></div></dl></article>
                </div>
                <p className="report-rule">The public incident was first flagged in {benchmarkData.metrics.public_evaluator.first_public_incident_flag_week ?? 'the public evaluation period'}, matching the naive baseline week ({benchmarkData.metrics.public_evaluator.baseline_first_flag_week ?? 'not available'}); it did not lead the baseline. These results do not estimate hidden-set performance. The supplied package is synthetic and fictional. English and code-mixed subsets have not been scored separately. No transaction totals or hidden planted-incident labels were included. The duplicate queue is a text-similarity review aid; it does not confirm or merge incidents.</p>
              </section>
            </>
          )}

          {dataView === 'live' && (
            <section className="report-grid live-operations-brief-grid" id="live-alerts" aria-label="Live issue and regional summaries">
              <article className="panel report-panel" id="live-issue-watch">
                <div className="panel-heading">
                  <div>
                    <div className="panel-kicker"><span className="panel-kicker-dot peach" /> NORMALIZED ISSUE WATCH</div>
                    <h2>Issues gaining volume</h2>
                    <p>Store-level rates compared with four prior completed periods</p>
                  </div>
                </div>
                <p className="report-rule">The watch uses the latest completed period and compares deduplicated issue groups per transaction with each store&apos;s own history. It needs at least two issue groups and a rising rate; tune these provisional thresholds against the official evaluator. The weekly brief below can select an earlier week. Safety escalation remains independent of volume.</p>
                {emergingIssues.length > 0 ? (
                  <ul className="signal-list">
                    {emergingIssues.map((issue) => <li key={issue.category}><strong>{issue.category}</strong><span>{(issue.latestRate * 1000).toFixed(2)} vs {(issue.baselineRate * 1000).toFixed(2)} / 1k <b>·</b> {issue.latestIssueVolume} issue groups · {issue.risingStoreCount}/{issue.coveredStoreCount} stores rising</span></li>)}
                  </ul>
                ) : (
                  <div className="report-empty">No category currently meets the provisional rate-change rule. Weekly transaction totals and at least five completed periods are needed for each store.</div>
                )}
              </article>

              <article className="panel report-panel" id="live-weekly-brief">
                <div className="report-heading-row">
                  <div>
                    <div className="panel-kicker"><span className="panel-kicker-dot green" /> WEEKLY REGIONAL OPERATIONS BRIEF</div>
                    <h2>Top issues and follow-up</h2>
                    <p>Completed week · authorized incident records · linked feedback evidence</p>
                  </div>
                  <div className="benchmark-brief-filters">
                    <label className="region-picker"><span>Region</span><select aria-label="Choose live report region" value={selectedRegion} onChange={(event) => setSelectedRegion(event.target.value)}><option>All authorized regions</option>{regionalSummaries.map((summary) => <option key={summary.region}>{summary.region}</option>)}</select></label>
                    <label className="region-picker"><span>Week</span><select aria-label="Choose live report week" value={activeLiveWeekStart} onChange={(event) => setSelectedLiveWeekStart(event.target.value)} disabled={!liveReportWeeks.length}>{liveReportWeeks.map((period) => <option key={period.periodStart} value={period.periodStart}>{new Date(period.periodStart).toLocaleDateString()} – {new Date(period.periodEnd).toLocaleDateString()}</option>)}</select></label>
                  </div>
                </div>
                {activeLiveWeekStart && selectedRegionalSummaries.length > 0 ? (
                  <div className="regional-report-list">
                    {selectedRegionalSummaries.map((summary) => <section className="regional-summary-block" key={summary.region}>
                      <div className="regional-summary-heading"><strong>{summary.region}</strong><span>{summary.periodStart && summary.periodEnd ? `${new Date(summary.periodStart).toLocaleDateString()} – ${new Date(summary.periodEnd).toLocaleDateString()}` : 'No weekly transaction periods loaded'}</span><span>Coverage {summary.coveredStoreCount}/{summary.expectedStoreCount} stores</span></div>
                      {summary.topIssues.length ? summary.topIssues.map((issue) => <article className="regional-issue" key={issue.category}>
                        <div className="regional-issue-title"><strong>{issue.category}</strong><span>{issue.severity ?? 'Severity not recorded'} · {issue.issueVolume} issue groups</span></div>
                        <div className="regional-issue-meta">{issue.trend === 'up' ? '↑ Rising' : issue.trend === 'down' ? '↓ Falling' : issue.trend === 'flat' ? '→ Flat' : '— Previous-week comparison unavailable'}{issue.normalizedRate !== null && issue.previousNormalizedRate !== null ? ` · ${issue.normalizedRate.toFixed(2)} vs ${issue.previousNormalizedRate.toFixed(2)} issue groups per 1k transactions` : ''} · Responsible department: {issue.owner} · Affected stores: {issue.affectedStores.join(', ') || 'Not listed'}</div>
                        <p className="report-rule">{issue.recommendedAction ?? 'No recommended action is recorded for these incidents.'}</p>
                        {issue.quotes.length > 0
                          ? issue.quotes.map((quote, index) => <blockquote key={`${issue.category}-${index}`}>&ldquo;{quote.text}&rdquo; <cite>— {quote.source}</cite></blockquote>)
                          : <div className="report-empty">No source feedback quote is available for this issue in the selected week.</div>}
                      </article>) : <div className="report-empty">No issue categories are available in this period. Import verified store transaction totals to build the report.</div>}
                    </section>)}
                  </div>
                ) : (
                  <div className="report-empty">{liveReportWeeks.length ? 'No authorized regions are available for this completed week.' : 'No completed weekly transaction periods are available for the authorized stores.'}</div>
                )}
                <p className="report-rule">Rates compare the same covered stores week over week and average each store equally. Missing prior-week records are shown as unavailable; no zero baseline is inferred. Coverage excludes missing or zero transaction denominators.</p>
              </article>
            </section>
          )}

          <section className="panel solution-panel" id="solution-design" aria-label="Problem understanding, AI role, solution coverage and architecture">
            <div className="solution-header">
              <div>
                <div className="panel-kicker"><span className="panel-kicker-dot green" /> R5 PROJECT DESIGN</div>
                <h2>From scattered reports to a weekly action plan</h2>
                <p>What the challenge asks for, where AI helps, and what this build can verify today.</p>
              </div>
              <span className="solution-source-tag">Public benchmark · synthetic data</span>
            </div>

            <div className="solution-facts" aria-label="Dataset overview">
              <span><strong>{benchmarkData?.summary.feedback_records.toLocaleString() ?? '≈40K'}</strong> feedback records</span>
              <span><strong>{Object.keys(benchmarkData?.summary.channel_counts ?? { reviews: 1, app: 1, staff: 1, tickets: 1 }).length}</strong> source channels</span>
              <span><strong>{benchmarkData?.summary.taxonomy_categories ?? '~30'}</strong> issue types</span>
              <span><strong>{benchmarkData?.summary.stores ?? '60'}</strong> stores</span>
              <span><strong>{benchmarkData?.summary.public_training_labels.toLocaleString() ?? '3,000'}</strong> public training labels</span>
            </div>

            <div className="solution-grid">
              <article className="solution-card">
                <span className="solution-label"><i>01</i> PROBLEM UNDERSTANDING</span>
                <h3>Local issues disappear in a noisy stream</h3>
                <p>Online reviews, app comments, staff WhatsApp/shift notes and call-centre transcripts describe the same operations in different voices. Messages may switch between English, Hinglish and transliterated Tamil or Marathi, with spelling errors, emojis and missing context. Call-centre records are transcripts; no audio processing is needed.</p>
                <ul>
                  <li>One complaint is unverified evidence, not proof of a store-wide problem.</li>
                  <li>Store sizes differ, so comparisons need a per-store rate rather than raw counts.</li>
                  <li>Safety, allergen, hygiene and misconduct signals need a policy route even when volume is low.</li>
                  <li>The store master and issue taxonomy link each case to Store Ops, Supply Chain, Merchandising, Digital or HR.</li>
                </ul>
              </article>

              <article className="solution-card">
                <span className="solution-label"><i>02</i> ROLE OF AI</span>
                <h3>Sort, prioritize and show the evidence</h3>
                <p>Word and character TF‑IDF features feed separate LinearSVC classifiers for issue type, severity and actionability; the taxonomy supplies the owning function. A store-level detector compares normalized rates with that store’s recent history to find a small but sharp local rise. Character features help with spelling variation and transliterated word forms; the system does not translate or replace the original quote.</p>
                <div className="solution-policy"><ShieldAlert size={16} /><span><strong>Escalation rule: policy before volume</strong>Allergen, cold-chain, contamination and hygiene reports are critical and routed immediately for human review regardless of volume. Staff-misconduct reports are high priority and also require immediate human review. The model does not confirm the allegation or send an external alert.</span></div>
              </article>

              <article className="solution-card coverage-card">
                <span className="solution-label"><i>03</i> SOLUTION COMPLETENESS</span>
                <h3>Implemented and still to validate</h3>
                <div className="coverage-columns">
                  <div>
                    <strong className="coverage-heading implemented"><Check size={14} /> In this build</strong>
                    <ul>
                      <li>Taxonomy category, severity, actionability and owner routing.</li>
                      <li>Regional top-five brief with source quotes, affected stores and week-over-week trend.</li>
                      <li>Store-level emerging flags, evidence references, CSV export, human review controls and a duplicate review that updates regional counts/rates after confirmation.</li>
                    </ul>
                  </div>
                  <div>
                    <strong className="coverage-heading remaining"><Activity size={14} /> Known limits</strong>
                    <ul>
                      <li>Benchmark duplicate candidates use exact and character similarity for human review. In live use, a same-store cross-channel match can be attached as evidence to one incident after an explicit reviewer choice; a separate incident can also be kept.</li>
                      <li>Language-specific scores are not reported, and hidden planted incidents are unavailable for public verification.</li>
                      <li>The provided ZIP has no transaction totals. The brief accepts a validated store/week CSV; public detector flags still use footfall.</li>
                    </ul>
                  </div>
                </div>
                {benchmarkData && <p className="solution-precision"><strong>Actionability precision:</strong> Of cases predicted actionable, {(benchmarkData.metrics.holdout.actionable_precision * 100).toFixed(1)}% were labeled actionable across {benchmarkData.metrics.holdout.rows.toLocaleString()} chronological holdout rows. This is a global validation metric, not a per-region guarantee or a hidden-set score.</p>}
              </article>
            </div>

            <div className="solution-architecture" id="architecture">
              <div className="architecture-title"><div><span className="solution-label"><i>04</i> ARCHITECTURE / TECH STACK</span><h3>One traceable path from input to owner</h3></div><p>Benchmark views stay read-only; authenticated incident storage is optional.</p></div>
              <div className="architecture-flow">
                <div><span>01 · INTAKE</span><strong>Four channels</strong><small>Reviews · app · shift notes · tickets</small></div><ArrowRight size={16} />
                <div><span>02 · FRONT END</span><strong>React · TypeScript · Vite</strong><small>Filter, review, export and collect feedback</small></div><ArrowRight size={16} />
                <div><span>03 · API &amp; ML</span><strong>FastAPI · Python · scikit-learn</strong><small>Word/character TF‑IDF · three LinearSVC models</small></div><ArrowRight size={16} />
                <div><span>04 · OPERATIONS</span><strong>Taxonomy · safety rules · detector</strong><small>Owner routing · reviewed duplicates · normalized rates</small></div><ArrowRight size={16} />
                <div><span>05 · STORAGE</span><strong>Supabase · PostgreSQL</strong><small>Optional live records with row-level access rules</small></div>
              </div>
              <p className="architecture-note"><BrainCircuit size={14} /> AI is a triage assistant: it surfaces likely issues and supporting quotes, while store teams verify, prioritize and own the final action.</p>
            </div>
          </section>

          <section className="panel analyzer-panel" id="analyze-feedback" aria-labelledby="analyzer-title">
            <div className="analyzer-heading">
              <div>
                <div className="panel-kicker"><span className="panel-kicker-dot green" /> FEEDBACK TRIAGE</div>
                <h2 id="analyzer-title">Analyze new feedback</h2>
                <p>Submit a message to get a transparent category, priority, and suggested owner.</p>
              </div>
              <span className="analysis-method-pill"><Sparkles size={13} /> Model when available · safety rules active</span>
            </div>

            <div className="analyzer-grid">
              <form className="analyzer-form" onSubmit={analyzeFeedback} noValidate>
                <label className="analyzer-field">
                  <span>Feedback text <b>*</b></span>
                  <textarea
                    value={feedbackText}
                    onChange={(event) => { setFeedbackText(event.target.value); setPendingLiveDuplicate(null); }}
                    maxLength={2000}
                    rows={4}
                    placeholder="Example: The freezer is broken and frozen items are soft."
                    aria-label="Feedback text"
                    required
                  />
                  <small>{feedbackText.length}/2,000 characters</small>
                </label>

                <div className="sample-prompts" aria-label="Example feedback inputs">
                  <span>Load an example</span>
                  {exampleFeedback.map((example) => (
                    <button key={example.label} onClick={() => { setFeedbackText(example.text); setSource(example.source); setAnalysis(null); setPendingLiveDuplicate(null); setAnalysisError(''); setAnalysisNotice(''); }} title={example.label} type="button">
                      <Globe2 size={12} />{example.label}
                    </button>
                  ))}
                </div>
                <p className="language-support-note">Examples are illustrative inputs, not dataset quotes. The original message is retained; language-specific validation scores are not available.</p>

                <div className="analyzer-field-row">
                  {session && memberships.length > 0 ? (
                    <label className="analyzer-field store-select-field">
                      <span>Authorized store <b>*</b></span>
                      <select value={selectedStoreId} onChange={(event) => { setSelectedStoreId(event.target.value); setPendingLiveDuplicate(null); }} required>
                        {memberships.map((membership) => <option value={membership.store.id} key={membership.store.id}>{membership.store.name} · {membership.store.region}</option>)}
                      </select>
                    </label>
                  ) : (
                    <>
                      <label className="analyzer-field">
                        <span>Identifier type <b>*</b></span>
                        <select
                          value={storeIdentifierType}
                          onChange={(event) => { setStoreIdentifierType(event.target.value as 'name' | 'id'); setPendingLiveDuplicate(null); }}
                        >
                          <option value="name">Store name</option>
                          <option value="id">Store ID</option>
                        </select>
                      </label>
                      <label className="analyzer-field">
                        <span>{storeIdentifierType === 'name' ? 'Store name' : 'Store ID'} <b>*</b></span>
                        <input
                          value={storeIdentifier}
                          onChange={(event) => { setStoreIdentifier(event.target.value); setPendingLiveDuplicate(null); }}
                          maxLength={120}
                          placeholder={storeIdentifierType === 'name' ? 'Enter a store name' : 'Enter a store ID'}
                          aria-label={storeIdentifierType === 'name' ? 'Store name' : 'Store ID'}
                          list={storeIdentifierType === 'name' ? 'r5-store-names' : 'r5-store-ids'}
                          required
                        />
                        <datalist id="r5-store-names">{benchmarkData?.summary.store_options.map((store) => <option key={store.store_id} value={store.store_name} label={`${store.region} · ${store.location}`} />)}</datalist>
                        <datalist id="r5-store-ids">{benchmarkData?.summary.store_options.map((store) => <option key={store.store_id} value={store.store_id} label={`${store.store_name} · ${store.region}`} />)}</datalist>
                      </label>
                    </>
                  )}
                </div>
                {session && memberships.length === 0 && <p className="store-access-note">You can analyze a message here, but saving a shared incident requires an administrator to grant your account store access.</p>}
                {!session && <p className="store-access-note">Choose a store from the official store master suggestions for valid store-level routing. Unknown names stay in human review.</p>}

                <label className="analyzer-field source-field">
                  <span>Source <b>*</b></span>
                  <select value={source} onChange={(event) => { setSource(event.target.value); setPendingLiveDuplicate(null); }}>
                    <option value="online_review">Online review</option>
                    <option value="in_app">In-app feedback</option>
                    <option value="staff_shift_note">Store-staff shift note</option>
                    <option value="call_centre_ticket">Call-centre ticket</option>
                  </select>
                </label>

                {analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}
                <button className="button analyze-button" type="submit" disabled={isAnalyzing || isSavingIncident}>
                  <Send size={15} />
                  {isSavingIncident ? 'Saving incident…' : isAnalyzing ? 'Analyzing…' : 'Analyze feedback'}
                </button>
                <p className="analyzer-disclaimer">The API uses the trained R5 classifiers when the local model artifact is available and otherwise falls back to keyword rules. The model has no calibrated per-message confidence score, so this app does not show a confidence percentage. Safety candidates still require human verification. Possible repeats are suggested from recent cross-channel text overlap and need a person&apos;s choice. Signed-in, authorized submissions are saved in this app; external teams are not notified.</p>
              </form>

              <div className={`analysis-result ${analysis ? 'has-result' : ''}`} aria-live="polite">
                {analysis ? (
                  <>
                    <div className="analysis-result-topline">
                      <span className="result-eyebrow">ANALYSIS RESULT</span>
                      <span className="rule-method-label">{classificationMethodLabel(analysis.classification_method)}</span>
                    </div>
                    <div className="analysis-result-title-row">
                      <div>
                        <span className="result-field-label">Issue category</span>
                        <h3>{isRecognizedCategory(analysis) ? analysis.category : `Unrecognized: ${analysis.category}`}</h3>
                      </div>
                      <span className={`severity-badge ${analysis.severity.toLowerCase()}`}><i />{analysis.severity}</span>
                    </div>
                    <div className="analysis-actionability-row">
                      <span className="result-field-label">Actionability</span>
                      <span className={`actionability-badge ${analysis.actionability}`}>
                        {analysis.actionability.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="result-department">
                      <span className="result-field-label">Recommended department</span>
                      <strong>{analysis.recommended_department}</strong>
                    </div>
                    {analysis.assigned_department && <div className="result-department assigned-department-result"><span className="result-field-label">Assigned team · in this app</span><strong>{analysis.assigned_department}</strong></div>}
                    <div className="result-recommended-action">
                      <span className="result-field-label">Recommended action</span>
                      <p>{analysis.recommended_action}</p>
                    </div>
                    <div className="result-explanation">
                      <span className="result-field-label">Why this was flagged</span>
                      <p>{analysis.explanation}</p>
                    </div>
                    <div className={`result-status ${analysis.requires_human_verification ? 'needs-review' : ''}`}>
                      <span className="result-status-dot" />
                      <span><b>{analysis.status}</b>{analysis.requires_human_verification && <small>Human review required</small>}</span>
                    </div>
                    {analysis.escalation_required && (
                      <div className="escalation-notice" role="alert">
                        <strong>Immediate safety escalation required</strong>
                        <span>Follow the store's established safety procedure and obtain human verification. The app records the candidate; it does not dispatch an external alert.</span>
                      </div>
                    )}
                    {!isRecognizedCategory(analysis) && (
                      <p className="unknown-category-note">This category is not recognized by the dashboard. Review the message manually before routing.</p>
                    )}
                    {pendingLiveDuplicate && (
                      <div className="live-duplicate-review" role="group" aria-label="Review possible duplicate incident">
                        <div className="live-duplicate-review-heading">
                          <strong>{pendingLiveDuplicate.match_type === 'exact_text' ? 'Same text found in another channel' : 'Possible repeat incident'}</strong>
                          <span>{Math.round(pendingLiveDuplicate.similarity * 100)}% text similarity</span>
                        </div>
                        <p>Same store and issue type, within the last seven days, from a different channel. Review the source message before grouping; text similarity is only a suggestion.</p>
                        <blockquote>{pendingLiveDuplicate.matched_text}</blockquote>
                        <small>Incident {pendingLiveDuplicate.incident.id.slice(0, 8)} · {sourceLabel(pendingLiveDuplicate.matched_source)} · {new Date(pendingLiveDuplicate.matched_at).toLocaleString()}</small>
                        <div className="live-duplicate-review-actions">
                          <button className="button button-secondary" type="button" disabled={isSavingIncident} onClick={() => void attachPendingDuplicateEvidence()}>
                            {isSavingIncident ? 'Saving…' : 'Add as supporting evidence'}
                          </button>
                          <button className="button button-outline" type="button" disabled={isSavingIncident} onClick={() => void createSeparateIncident()}>
                            Keep as separate incident
                          </button>
                          <button className="live-duplicate-dismiss" type="button" disabled={isSavingIncident} onClick={() => { setPendingLiveDuplicate(null); setAnalysisNotice('No incident was saved. You can submit again when ready.'); }}>
                            Review later
                          </button>
                        </div>
                      </div>
                    )}
                    {analysisNotice && <p className={`result-notice ${analysis.incident_id ? 'saved-notice' : ''}`} role="status">{analysisNotice}</p>}
                  </>
                ) : (
                  <div className="analysis-empty-state">
                    <span className="analysis-empty-icon"><MessageSquareText size={18} /></span>
                    <strong>{isAnalyzing ? 'Checking the feedback…' : 'Your analysis will appear here'}</strong>
                    <span>Possible food-safety and allergen signals are marked critical candidates for human verification.</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="panel feedback-panel" id="feedback">
            <div className="feedback-heading">
              <div>
                <div className="panel-kicker"><span className="panel-kicker-dot green" /> STORE FLOOR SIGNALS</div>
                <h2>{dataView === 'demo' ? 'Latest organizer feedback' : dataView === 'local' ? 'Local incident register' : 'Incident register'}</h2>
                <p>{dataView === 'live' ? 'Saved records for your authorized stores. Update the in-app team or incident status.' : dataView === 'local' ? 'Browser-only records with original feedback evidence. Team and status edits stay local.' : 'Original organizer text paired with the generated public prediction output. Historical benchmark rows do not have workflow status.'}</p>
              </div>
              <div className="feedback-heading-meta"><span className="sample-count">{visibleFeedback.length} {dataView === 'demo' ? 'benchmark records' : 'incidents'}</span><span className="freshness"><span /> {freshnessLabel}</span></div>
            </div>

            <div className="table-toolbar">
              <label className="search-box">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search feedback, store, team, or category" aria-label="Search feedback" />
                {query && <button type="button" className="clear-search" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
              </label>
              <div className="feedback-filter-panel" aria-label="Filter feedback and incidents">
                <div className="filter-controls" aria-label="Filter by severity">
                  <span className="filter-label">Severity</span>
                  <div className="severity-filters">
                    {severityFilters.map((filter) => (
                      <button key={filter} className={`filter-chip ${severity === filter ? 'selected' : ''} ${filter.toLowerCase()}`} onClick={() => setSeverity(filter)} type="button" aria-pressed={severity === filter}>
                        {filter === 'All' ? 'All' : filter}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="scope-filter-grid">
                  <label><span>Store</span><select aria-label="Filter by store" value={storeFilter} onChange={(event) => setStoreFilter(event.target.value)}><option>All stores</option>{feedbackFilterOptions.stores.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label><span>Region</span><select aria-label="Filter by region" value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)}><option>All regions</option>{feedbackFilterOptions.regions.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label><span>Category</span><select aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option>All categories</option>{feedbackFilterOptions.categories.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label><span>Owner</span><select aria-label="Filter by owner" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option>All owners</option>{feedbackFilterOptions.owners.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label><span>Channel</span><select aria-label="Filter by channel" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}><option>All channels</option>{feedbackFilterOptions.channels.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label><span>Status</span><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All statuses</option>{feedbackFilterOptions.statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
                </div>
              </div>
            </div>

            {incidentError && <div className="table-error" role="alert">Could not load or update the incident register: {incidentError}</div>}
            <div className="table-scroll">
              <table className="feedback-table">
                <thead>
                  <tr><th scope="col">SUPPORTING FEEDBACK EVIDENCE</th><th scope="col">STORE</th><th scope="col">ISSUE TYPE</th><th scope="col">SEVERITY</th><th scope="col">RESPONSIBLE DEPARTMENT</th><th scope="col">RECOMMENDED ACTION</th><th scope="col">STATUS</th></tr>
                </thead>
                <tbody>
                  {visibleFeedback.length > 0 ? visibleFeedback.map((item) => (
                    <tr key={item.id}>
                      <td className="feedback-cell"><div className="feedback-message" title={item.text}>{item.text}</div><div className="row-meta"><span>{item.id}</span><span className="meta-divider">·</span><span>{sourceLabel(item.source)}</span>{item.evidenceCount > 1 && <><span className="meta-divider">·</span><span>{item.evidenceCount} source reports grouped</span></>}<span className="meta-divider">·</span><span>{item.received}</span></div></td>
                      <td><div className="store-name">{item.store}</div><div className="store-location">{item.location}</div></td>
                      <td><span className="category-label">{item.category}</span></td>
                      <td><span className={`severity-badge ${item.severity.toLowerCase()}`}><i />{item.severity}</span></td>
                      <td>{dataView !== 'demo' && item.incidentId ? (
                        <select className="table-edit-select team-select" aria-label={`Assigned team for incident ${item.id}`} value={item.assignedDepartment} disabled={updatingIncidentId === item.incidentId} onChange={(event) => void updateSavedIncident(item.incidentId!, { assigned_department: event.target.value })}>
                          {[...new Set([...departmentOptions, item.assignedDepartment])].map((department) => <option key={department}>{department}</option>)}
                        </select>
                      ) : <span className="demo-team-label">Synthetic sample</span>}</td>
                      <td className="recommendation-cell">{item.recommendedAction}</td>
                      <td>{dataView !== 'demo' && item.incidentId ? (item.requiresHumanVerification && !item.humanVerifiedAt ? (
                        <div className="review-control">
                          <span className={`status-badge ${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span>
                          <button
                            className="review-action-button"
                            type="button"
                            disabled={updatingIncidentId === item.incidentId}
                            onClick={() => void updateSavedIncident(item.incidentId!, {
                              human_verified_at: new Date().toISOString(),
                              status: 'In Progress',
                            })}
                          >Confirm review</button>
                        </div>
                      ) : ['Open', 'In Progress', 'Resolved'].includes(item.status) ? (
                        <div className="status-control">
                          <select className="table-edit-select status-select" aria-label={`Status for incident ${item.id}`} value={item.status} disabled={updatingIncidentId === item.incidentId} onChange={(event) => void updateSavedIncident(item.incidentId!, { status: event.target.value as IncidentStatus })}>
                            {incidentStatuses.map((status) => <option key={status}>{status}</option>)}
                          </select>
                          {item.humanVerifiedAt && <small className="review-audit-label">Human review recorded</small>}
                        </div>
                      ) : <span className={`status-badge ${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span>) : <span className={`status-badge ${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span>}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={7} className="empty-state"><div className="empty-icon"><Search size={18} /></div><strong>{dataView === 'live' && isLoadingIncidents ? 'Loading authorized incidents…' : dataView === 'local' && localStoreSnapshot.error ? 'Local records could not be loaded' : dataView !== 'demo' && activeIncidents.length === 0 ? 'No saved incidents yet' : dataView === 'demo' && benchmarkLoading ? 'Loading organizer feedback…' : dataView === 'demo' && benchmarkError ? 'R5 benchmark is unavailable' : 'No feedback matches these filters'}</strong><span>{dataView === 'local' && localStoreSnapshot.error ? localStoreSnapshot.error : dataView === 'local' && activeIncidents.length === 0 ? 'Submit feedback to analyze it and save a browser-local incident.' : dataView === 'live' && activeIncidents.length === 0 ? 'Submit an analysis while signed in and assigned to a store to create the first incident.' : dataView === 'demo' && benchmarkError ? benchmarkError : dataView === 'demo' && !benchmarkData ? 'Start the FastAPI backend to load public organizer records and official predictions.' : 'Try a different search or severity.'}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>{dataView === 'live' ? 'Showing saved incidents from the last 14 days' : dataView === 'local' ? 'Showing incidents saved in this browser' : 'Showing latest organizer records · original IDs retained'}</span><span className="table-footer-right">{dataView === 'live' ? 'Store-scoped access · team assignment is internal to this app' : dataView === 'local' ? 'Browser-local data · not synchronized with a database' : 'Public benchmark output · not live incidents'}</span></div>
          </section>

          <footer className="page-footer">
            <span><span className="footer-logo"><Store size={13} /></span> Voice of Store <span className="footer-separator">·</span> Hackathon presentation build</span>
            <span>Every signal deserves a response.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
