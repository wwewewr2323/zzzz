import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  BookOpen,
  Check,
  History,
  Loader2,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type EvaluationRunSummary,
  type IntelligenceOverviewResponse,
} from '../api/client';
import { MATERIAL_LIBRARY } from '../shared/leatherKnowledge';
import type { Project } from '../shared/types';

type IntelTab = 'memories' | 'knowledge' | 'cases' | 'learning' | 'evaluation';

interface IntelligenceDrawerProps {
  activeProject: Project | null;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

const REVIEW_LEVEL_TEXT: Record<number, string> = {
  1: 'LEVEL 1 · AI 推测（仅供参考）',
  2: 'LEVEL 2 · 几何验证',
  3: 'LEVEL 3 · 用户确认',
  4: 'LEVEL 4 · 专业打版师审核',
  5: 'LEVEL 5 · 实际生产验证',
};

const SCOPE_TEXT: Record<string, string> = {
  A_PLATFORM_PUBLIC: 'A 类 · 全平台共享知识',
  B_ENTERPRISE_PRIVATE: 'B 类 · 企业私有知识',
  C_USER_PRIVATE: 'C 类 · 用户个人设计',
  D_AI_CANDIDATE: 'D 类 · AI 待审核经验',
};

const CLASSIFICATION_TEXT: Record<string, string> = {
  project_specific: '单项目特殊要求',
  user_preference: '用户个人偏好',
  reusable_experience: '可复用专业经验',
  general_rule_candidate: '通用工程规则候选',
};

export const IntelligenceDrawer: React.FC<IntelligenceDrawerProps> = ({
  activeProject,
  onClose,
  onNotify,
}) => {
  const [tab, setTab] = useState<IntelTab>('memories');
  const [data, setData] = useState<IntelligenceOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Layer 2 new memory draft
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryContent, setMemoryContent] = useState('');

  // Archive case state
  const [archiveScope, setArchiveScope] = useState<'C_USER_PRIVATE' | 'A_PLATFORM_PUBLIC'>(
    'C_USER_PRIVATE'
  );
  const [archiveNote, setArchiveNote] = useState('');

  // Evaluation run summary
  const [evalSummary, setEvalSummary] = useState<EvaluationRunSummary | null>(null);

  // Hybrid search test inside Knowledge tab
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<string[] | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.getIntelligenceOverview();
      setData(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载知识与记忆系统失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const handleToggleConsent = async (enabled: boolean) => {
    if (!data) return;
    setBusyAction('consent');
    try {
      const { preferences } = await api.updatePreferences({
        ...data.userPreferences,
        memoryConsentEnabled: enabled,
      });
      setData({ ...data, userPreferences: preferences });
      onNotify(enabled ? '已开启个人长期记忆学习授权' : '已关闭个人长期记忆记录');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '更新授权失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleTogglePreferredMaterial = async (materialId: string) => {
    if (!data) return;
    setBusyAction(`mat_${materialId}`);
    try {
      const curr = new Set(data.userPreferences.preferredMaterials ?? []);
      if (curr.has(materialId)) {
        curr.delete(materialId);
      } else {
        curr.add(materialId);
      }
      const { preferences } = await api.updatePreferences({
        ...data.userPreferences,
        preferredMaterials: Array.from(curr),
      });
      setData({ ...data, userPreferences: preferences });
      onNotify('已更新常用皮料偏好');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '更新材料偏好失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memoryKey.trim() || !memoryContent.trim()) return;
    setBusyAction('add_mem');
    setErrorMsg(null);
    try {
      await api.upsertMemory({
        memoryLayer: 'user_long_term',
        memoryKey: memoryKey.trim(),
        content: memoryContent.trim(),
        applicableBagTypes: activeProject ? [activeProject.bagType] : [],
        applicableMaterials: activeProject ? [activeProject.materialId] : [],
        sourceProjectId: activeProject?.id,
      });
      setMemoryKey('');
      setMemoryContent('');
      await loadOverview();
      onNotify('已保存至用户长期记忆');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '保存长期记忆失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setBusyAction(`del_${id}`);
    try {
      await api.deleteMemory(id);
      await loadOverview();
      onNotify('已删除该条个人记忆');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '删除记忆失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleHybridSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setBusyAction('search');
    try {
      const res = await api.retrieveMemory(activeProject?.id ?? '', searchQuery.trim());
      const hits = [
        ...res.engineeringKnowledge.map((k) => `[专业知识 L${k.reviewLevel}] ${k.title} — ${k.content}`),
        ...res.similarCases.map((c) => `[历史案例 L${c.reviewLevel}] ${c.title}`),
        ...res.experienceRecords.map((x) => `[错题修复 L${x.reviewLevel}] ${x.errorLocation} -> ${x.fixMethod}`),
      ];
      setSearchResults(hits);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '混合检索引擎查询失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleReviewCandidate = async (
    id: string,
    action: 'approve' | 'reject',
    targetReviewLevel = 4
  ) => {
    setBusyAction(`rev_${id}`);
    setErrorMsg(null);
    try {
      await api.reviewLearningCandidate(id, {
        action,
        targetReviewLevel,
        securityScope: targetReviewLevel >= 4 ? 'A_PLATFORM_PUBLIC' : 'C_USER_PRIVATE',
        createEvalCase: action === 'approve',
      });
      await loadOverview();
      onNotify(
        action === 'approve'
          ? `已核准升级至 LEVEL ${targetReviewLevel}，并同步生成新知识版本与测试案例`
          : '已驳回该条待审核经验'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '审核操作失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRollbackVersion = async (versionId: string) => {
    setBusyAction(`rb_${versionId}`);
    setErrorMsg(null);
    try {
      await api.rollbackKnowledgeVersion(versionId);
      await loadOverview();
      onNotify('已安全回滚该知识版本，未影响历史已验证设计');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '版本回滚失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleArchiveCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject) return;
    setBusyAction('archive_case');
    setErrorMsg(null);
    try {
      await api.archiveProjectCase(activeProject.id, {
        securityScope: archiveScope,
        productionResultNote: archiveNote.trim(),
      });
      setArchiveNote('');
      await loadOverview();
      onNotify('已将当前项目归档至工程案例库');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '归档项目案例失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunEvaluation = async () => {
    setBusyAction('eval');
    setErrorMsg(null);
    try {
      const summary = await api.runEvaluationSuite();
      setEvalSummary(summary);
      await loadOverview();
      onNotify(
        summary.allowedToDeploy
          ? `10 项 AI 能力评估全部通过（${summary.passedCount}/${summary.totalTests}）`
          : '检测到能力退化，已阻断知识发布'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '运行评估测试集失败');
    } finally {
      setBusyAction(null);
    }
  };

  const pendingCandidatesCount =
    data?.learningCandidates.filter((c) => c.status === 'pending').length ?? 0;

  return (
    <div className="fixed inset-0 z-50 bg-[#141413]/45 flex items-center justify-center p-4">
      <div className="w-full max-w-[1080px] h-[86vh] bg-[#FFFFFF] border border-[#E4E2DC] rounded-lg flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#E4E2DC] bg-[#FAF9F6] flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="font-display text-base font-semibold text-[#141413]">
              RUDA Leather Intelligence · 专业知识库与长期记忆系统
            </h2>
            <p className="text-xs text-[#5C5B57] mt-0.5 font-mono tabular-nums">
              知识版本 {data?.knowledgeVersion ?? 'KB-2026.11-PRO'}
              <span aria-hidden="true"> · </span>
              五层记忆架构
              <span aria-hidden="true"> · </span>
              LEVEL 1–5 人工审核分级
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭知识与记忆系统"
            className="p-1.5 text-[#5C5B57] hover:text-[#141413] rounded hover:bg-[#ECEAE3] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 border-b border-[#E4E2DC] bg-[#FFFFFF] flex items-center gap-6 overflow-x-auto shrink-0">
          {[
            { id: 'memories', label: '五层记忆与偏好' },
            { id: 'knowledge', label: '专业知识库 (L1-L5)' },
            { id: 'cases', label: '工程案例与错题经验' },
            {
              id: 'learning',
              label: `持续学习审核 (${pendingCandidatesCount})`,
            },
            { id: 'evaluation', label: 'AI 能力回归评估' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id as IntelTab)}
              className={`py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                tab === t.id
                  ? 'border-[#9A4D22] text-[#9A4D22]'
                  : 'border-transparent text-[#5C5B57] hover:text-[#141413]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {errorMsg && (
          <div className="mx-6 mt-4 px-3.5 py-2 text-xs bg-[#FEF2F2] border border-[#DC2626]/30 text-[#991B1B] rounded">
            {errorMsg}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading || !data ? (
            <div className="py-16 flex flex-col items-center justify-center text-sm text-[#5C5B57] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[#9A4D22]" />
              正在加载五层记忆与工程知识库...
            </div>
          ) : null}

          {/* TAB 1: Five-Layer Memory & Preferences */}
          {!loading && data && tab === 'memories' && (
            <div className="space-y-6">
              {/* Layer 2 User Consent & Preferred Materials */}
              <div className="border border-[#E4E2DC] rounded-lg p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-[#141413]">
                      第二层：用户长期记忆与授权控制
                    </h3>
                    <p className="text-xs text-[#5C5B57] mt-1">
                      记录您的常用皮料、工艺习惯与尺寸规则，仅归属您个人账户隔离保存（C 类隔离）。
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-medium text-[#141413] shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={data.userPreferences.memoryConsentEnabled !== false}
                      disabled={busyAction === 'consent'}
                      onChange={(e) => handleToggleConsent(e.target.checked)}
                      className="accent-[#9A4D22]"
                    />
                    允许积累个人长期记忆
                  </label>
                </div>

                <div>
                  <div className="text-xs font-medium text-[#5C5B57] mb-2">
                    常用主皮料偏好（新建项目时自动应用首选项）：
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {MATERIAL_LIBRARY.filter(
                      (m) => m.category !== 'lining' && m.category !== 'reinforcement'
                    ).map((mat) => {
                      const active = (data.userPreferences.preferredMaterials ?? []).includes(
                        mat.id
                      );
                      return (
                        <button
                          key={mat.id}
                          type="button"
                          disabled={busyAction === `mat_${mat.id}`}
                          onClick={() => handleTogglePreferredMaterial(mat.id)}
                          className={`px-3 py-1.5 text-xs rounded border transition-colors whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-[#9A4D22] text-white border-[#9A4D22]'
                              : 'bg-[#FAF9F6] text-[#141413] border-[#D8D5CD] hover:border-[#9A4D22]'
                          }`}
                        >
                          {mat.name} ({mat.thicknessMm}mm)
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Layer 3 Active Project Memory Snapshot */}
              {activeProject && (
                <div className="border border-[#E4E2DC] rounded-lg p-5 bg-[#FAF9F6] space-y-2">
                  <h3 className="text-sm font-semibold text-[#141413]">
                    第三层：当前项目长期记忆（自动持久化与恢复）
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1 text-xs">
                    <div>
                      <div className="text-[#78756E]">项目名称</div>
                      <div className="font-medium text-[#141413] mt-0.5 truncate">
                        {activeProject.name}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#78756E]">参考照片 / 视觉分析</div>
                      <div className="font-mono tabular-nums text-[#141413] mt-0.5">
                        {activeProject.images.length} 张 · {activeProject.visionSummary ? '已分析' : '未分析'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#78756E]">部件 / 纸格 / 连接关系</div>
                      <div className="font-mono tabular-nums text-[#141413] mt-0.5">
                        {activeProject.components.length} / {activeProject.patterns.length} /{' '}
                        {activeProject.relations.length}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#78756E]">修改历史 / 指令日志</div>
                      <div className="font-mono tabular-nums text-[#141413] mt-0.5">
                        {activeProject.versions.length} 版本 · {activeProject.commandLog.length} 指令
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Add Memory Form */}
              <form
                onSubmit={handleAddMemory}
                className="border border-[#E4E2DC] rounded-lg p-5 space-y-3"
              >
                <div className="text-sm font-semibold text-[#141413]">
                  新增个人设计规则 / 长期记忆（支持语义向量检索与同类自动合并）
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    value={memoryKey}
                    onChange={(e) => setMemoryKey(e.target.value)}
                    placeholder="记忆标识，如：tote_handle_drop"
                    className="px-3 py-2 text-xs bg-[#FAF9F6] border border-[#D8D5CD] rounded focus:outline-none focus:border-[#9A4D22]"
                  />
                  <input
                    type="text"
                    value={memoryContent}
                    onChange={(e) => setMemoryContent(e.target.value)}
                    placeholder="内容，如：通勤托特包默认提手净高 230mm，方便肩背"
                    className="sm:col-span-2 px-3 py-2 text-xs bg-[#FAF9F6] border border-[#D8D5CD] rounded focus:outline-none focus:border-[#9A4D22]"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busyAction === 'add_mem' || !memoryKey.trim() || !memoryContent.trim()}
                    className="px-4 py-1.5 text-xs font-medium text-white bg-[#141413] hover:bg-[#2C2C2A] disabled:opacity-45 rounded flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    写入长期记忆
                  </button>
                </div>
              </form>

              {/* Stored User Memories Table */}
              <div className="border border-[#E4E2DC] rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-[#FAF9F6] border-b border-[#E4E2DC] flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#141413]">
                    已存储的个人记忆条目 ({data.memories.length})
                  </span>
                  <span className="text-xs text-[#78756E]">支持随时删除与来源追溯</span>
                </div>
                {data.memories.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#78756E]">
                    暂无已保存的个人长期记忆条目。在工作区调整材料或新增规则后将自动沉淀至此。
                  </div>
                ) : (
                  <div className="divide-y divide-[#ECEAE3]">
                    {data.memories.map((mem) => (
                      <div
                        key={mem.id}
                        className="px-4 py-3 flex items-start justify-between gap-4"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="text-xs font-medium text-[#141413]">
                            {mem.content}
                          </div>
                          <div className="text-[11px] text-[#78756E] font-mono tabular-nums flex flex-wrap items-center gap-x-2">
                            <span>键: {mem.memoryKey}</span>
                            <span aria-hidden="true">·</span>
                            <span>{REVIEW_LEVEL_TEXT[mem.reviewLevel] || `LEVEL ${mem.reviewLevel}`}</span>
                            <span aria-hidden="true">·</span>
                            <span>来源: {mem.source}</span>
                            <span aria-hidden="true">·</span>
                            <span>合并次数 {mem.mergedCount}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDeleteMemory(mem.id)}
                          disabled={busyAction === `del_${mem.id}`}
                          aria-label="删除记忆"
                          className="p-1.5 text-[#78756E] hover:text-[#DC2626] shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Professional Engineering Knowledge (LEVEL 1–5 & Versioning) */}
          {!loading && data && tab === 'knowledge' && (
            <div className="space-y-6">
              {/* Hybrid pgvector + keyword search bar */}
              <form onSubmit={handleHybridSearch} className="flex items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="测试混合向量检索（关键词 + pgvector 语义相似度），例如：植鞣皮折边防裂、拉链退让量..."
                  className="flex-1 px-3.5 py-2 text-xs bg-[#FAF9F6] border border-[#D8D5CD] rounded focus:outline-none focus:border-[#9A4D22]"
                />
                <button
                  type="submit"
                  disabled={busyAction === 'search'}
                  className="px-4 py-2 text-xs font-medium text-white bg-[#9A4D22] hover:bg-[#823F1A] rounded whitespace-nowrap shrink-0"
                >
                  混合检索验证
                </button>
              </form>

              {searchResults && (
                <div className="border border-[#E4E2DC] bg-[#FAF9F6] rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#141413]">
                    <span>语义 + 结构过滤检索命中结果 ({searchResults.length})</span>
                    <button
                      type="button"
                      onClick={() => setSearchResults(null)}
                      className="text-[#78756E] hover:text-[#141413]"
                    >
                      清除结果
                    </button>
                  </div>
                  {searchResults.length === 0 ? (
                    <div className="text-xs text-[#78756E]">未命中相关知识记录。</div>
                  ) : (
                    searchResults.map((line, i) => (
                      <div key={i} className="text-xs text-[#141413] leading-relaxed">
                        • {line}
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Engineering Knowledge Documents */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-[#9A4D22]" />
                  第四层：专业工程知识文档 ({data.knowledgeDocs.length})
                </h3>
                <div className="divide-y divide-[#ECEAE3] border border-[#E4E2DC] rounded-lg">
                  {data.knowledgeDocs.map((doc) => (
                    <div key={doc.id} className="p-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm font-medium text-[#141413]">
                          {doc.title}
                        </span>
                        <span
                          className={`text-xs font-medium shrink-0 ${
                            doc.reviewLevel >= 4 ? 'text-[#16A34A]' : 'text-[#D97706]'
                          }`}
                        >
                          {REVIEW_LEVEL_TEXT[doc.reviewLevel] || `LEVEL ${doc.reviewLevel}`}
                        </span>
                      </div>
                      <p className="text-xs text-[#5C5B57] leading-relaxed">{doc.content}</p>
                      <div className="text-[11px] text-[#78756E] font-mono tabular-nums flex flex-wrap items-center gap-x-2">
                        <span>{SCOPE_TEXT[doc.securityScope] || doc.securityScope}</span>
                        <span aria-hidden="true">·</span>
                        <span>版本 {doc.version}</span>
                        <span aria-hidden="true">·</span>
                        <span>置信度 {Math.round(doc.confidence * 100)}%</span>
                        <span aria-hidden="true">·</span>
                        <span>来源: {doc.source}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Construction & Process Rules Summary */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-[#E4E2DC] rounded-lg p-4 space-y-2">
                  <h4 className="text-xs font-semibold text-[#141413]">
                    生产工艺规则 ({data.processRules.length})
                  </h4>
                  <div className="divide-y divide-[#ECEAE3]">
                    {data.processRules.map((pr) => (
                      <div key={pr.id} className="py-2 text-xs space-y-0.5">
                        <div className="font-medium text-[#141413]">
                          {pr.code} · {pr.name}
                        </div>
                        <div className="text-[#5C5B57] font-mono tabular-nums">
                          缝份 {pr.seamAllowanceMm}mm · 折边 {pr.foldWidthMm}mm · 铲薄目标 {pr.skiveEdgeTargetMm}mm · 针距 {pr.stitchSpacingMm}mm
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border border-[#E4E2DC] rounded-lg p-4 space-y-2">
                  <h4 className="text-xs font-semibold text-[#141413]">
                    结构与接缝公差规则 ({data.constructionRules.length})
                  </h4>
                  <div className="divide-y divide-[#ECEAE3]">
                    {data.constructionRules.map((cr) => (
                      <div key={cr.id} className="py-2 text-xs space-y-0.5">
                        <div className="font-medium text-[#141413]">
                          {cr.code} · {cr.title} (公差 ±{cr.toleranceMm}mm)
                        </div>
                        <div className="text-[#5C5B57] leading-snug">{cr.ruleDetail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Knowledge Version History & Safe Rollback */}
              <div className="border border-[#E4E2DC] rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-[#FAF9F6] border-b border-[#E4E2DC] flex items-center gap-2">
                  <History className="w-4 h-4 text-[#5C5B57]" />
                  <span className="text-xs font-semibold text-[#141413]">
                    专业知识版本管理与安全回滚 ({data.knowledgeVersions.length})
                  </span>
                </div>
                <div className="divide-y divide-[#ECEAE3]">
                  {data.knowledgeVersions.map((ver) => (
                    <div
                      key={ver.id}
                      className="px-4 py-3 flex items-center justify-between gap-4 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-[#141413] truncate">
                          {ver.versionTag} · {ver.changeSummary}
                        </div>
                        <div className="text-[11px] text-[#78756E] font-mono tabular-nums mt-0.5">
                          审核人: {ver.reviewerName} · LEVEL {ver.reviewLevel} ·{' '}
                          {new Date(ver.createdAt).toLocaleString('zh-CN')}
                        </div>
                      </div>
                      {ver.entityId !== 'platform_baseline' && !ver.id.startsWith('kver_rb_') && (
                        <button
                          type="button"
                          onClick={() => handleRollbackVersion(ver.id)}
                          disabled={busyAction === `rb_${ver.id}`}
                          className="px-2.5 py-1 text-xs font-medium text-[#141413] bg-[#F6F5F1] hover:bg-[#ECEAE3] border border-[#D8D5CD] rounded flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="w-3 h-3" />
                          回滚此版本
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Verified Engineering Cases & Historical Experience Records */}
          {!loading && data && tab === 'cases' && (
            <div className="space-y-6">
              {activeProject && (
                <form
                  onSubmit={handleArchiveCase}
                  className="border border-[#E4E2DC] bg-[#FAF9F6] rounded-lg p-5 space-y-3"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-1.5">
                        <Archive className="w-4 h-4 text-[#9A4D22]" />
                        归档当前项目为历史工程参考案例
                      </h3>
                      <p className="text-xs text-[#5C5B57] mt-0.5">
                        保存照片拆解、部件关系、原生纸格尺寸、几何校验及实物试制结果（案例仅供新项目参考，不直接复制投产）。
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    <select
                      value={archiveScope}
                      onChange={(e) =>
                        setArchiveScope(
                          e.target.value as 'C_USER_PRIVATE' | 'A_PLATFORM_PUBLIC'
                        )
                      }
                      className="px-3 py-2 text-xs bg-white border border-[#D8D5CD] rounded"
                    >
                      <option value="C_USER_PRIVATE">C 类 · 仅个人私有隔离</option>
                      <option value="A_PLATFORM_PUBLIC">A 类 · 脱敏共享案例</option>
                    </select>
                    <input
                      type="text"
                      value={archiveNote}
                      onChange={(e) => setArchiveNote(e.target.value)}
                      placeholder="实产检验备注（如：头件裁切缝合误差 < 0.6mm，包底挺括）"
                      className="sm:col-span-2 px-3 py-2 text-xs bg-white border border-[#D8D5CD] rounded"
                    />
                    <button
                      type="submit"
                      disabled={busyAction === 'archive_case'}
                      className="px-4 py-2 text-xs font-medium text-white bg-[#9A4D22] hover:bg-[#823F1A] rounded whitespace-nowrap shrink-0"
                    >
                      归档当前案例
                    </button>
                  </div>
                </form>
              )}

              {/* Verified Cases */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[#141413]">
                  真实工程打版案例库 ({data.patternCases.length})
                </h3>
                <div className="divide-y divide-[#ECEAE3] border border-[#E4E2DC] rounded-lg">
                  {data.patternCases.map((cs) => (
                    <div key={cs.id} className="p-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm font-medium text-[#141413]">
                          {cs.title}
                        </span>
                        <span
                          className={`text-xs font-medium shrink-0 ${
                            cs.productionVerified ? 'text-[#16A34A]' : 'text-[#5C5B57]'
                          }`}
                        >
                          {cs.productionVerified ? '实产验证通过 · ' : ''}
                          {REVIEW_LEVEL_TEXT[cs.reviewLevel] || `LEVEL ${cs.reviewLevel}`}
                        </span>
                      </div>
                      <p className="text-xs text-[#5C5B57]">{cs.processSummary}</p>
                      <p className="text-xs text-[#141413]">{cs.productionResultNote}</p>
                      <div className="text-[11px] text-[#78756E] font-mono tabular-nums">
                        {SCOPE_TEXT[cs.securityScope] || cs.securityScope} · 部件数{' '}
                        {cs.structureBreakdown.length} · 版本 {cs.version}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Historical Error & Fix Experiences */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[#141413]">
                  第五层：历史错题与修复经验库 ({data.experienceRecords.length})
                </h3>
                <div className="divide-y divide-[#ECEAE3] border border-[#E4E2DC] rounded-lg">
                  {data.experienceRecords.map((exp) => (
                    <div key={exp.id} className="p-4 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-semibold text-[#141413]">
                          问题定位：{exp.errorLocation}
                        </span>
                        <span className="text-[#16A34A] font-medium shrink-0">
                          {exp.productionVerified ? '实物已验证 · ' : ''}
                          {exp.geometryPassed ? '几何校验通过' : '待验证'}
                        </span>
                      </div>
                      <div className="text-[#5C5B57]">
                        <span className="font-medium text-[#141413]">发生原因：</span>
                        {exp.rootCause}
                      </div>
                      <div className="text-[#141413]">
                        <span className="font-medium text-[#9A4D22]">修复方法：</span>
                        {exp.fixMethod}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Continuous Learning Audit & LEVEL 1->5 Human Review Queue */}
          {!loading && data && tab === 'learning' && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-semibold text-[#141413]">
                    待审核新知识队列（LEVEL 1 AI 推测不得自动升级为正式工艺规则）
                  </h3>
                </div>
                {data.learningCandidates.length === 0 ? (
                  <div className="border border-[#E4E2DC] rounded-lg p-8 text-center text-xs text-[#78756E]">
                    暂无待审核的新提取经验。当您或打版师手动修改 AI 生成的纸格参数，或执行接缝修复后，系统会自动提炼候选经验至此队列。
                  </div>
                ) : (
                  <div className="divide-y divide-[#ECEAE3] border border-[#E4E2DC] rounded-lg">
                    {data.learningCandidates.map((cand) => (
                      <div key={cand.id} className="p-4 space-y-2">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-[#141413]">
                              {cand.title}
                            </div>
                            <div className="text-xs text-[#5C5B57] leading-relaxed">
                              {cand.proposedContent}
                            </div>
                            <div className="text-[11px] text-[#78756E] font-mono tabular-nums flex flex-wrap gap-x-2">
                              <span>
                                分类: {CLASSIFICATION_TEXT[cand.classification] || cand.classification}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{REVIEW_LEVEL_TEXT[cand.reviewLevel]}</span>
                              <span aria-hidden="true">·</span>
                              <span>状态: {cand.status}</span>
                              <span aria-hidden="true">·</span>
                              <span>{cand.source}</span>
                            </div>
                          </div>

                          {cand.status === 'pending' && (
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                disabled={busyAction === `rev_${cand.id}`}
                                onClick={() => handleReviewCandidate(cand.id, 'approve', 4)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-[#16A34A] hover:bg-[#15803D] rounded flex items-center gap-1 whitespace-nowrap shrink-0"
                              >
                                <Check className="w-3.5 h-3.5" />
                                核准升级 (LEVEL 4)
                              </button>
                              <button
                                type="button"
                                disabled={busyAction === `rev_${cand.id}`}
                                onClick={() => handleReviewCandidate(cand.id, 'approve', 5)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-[#9A4D22] hover:bg-[#823F1A] rounded whitespace-nowrap shrink-0"
                              >
                                实产验证 (LEVEL 5)
                              </button>
                              <button
                                type="button"
                                disabled={busyAction === `rev_${cand.id}`}
                                onClick={() => handleReviewCandidate(cand.id, 'reject', 1)}
                                className="px-3 py-1.5 text-xs font-medium text-[#5C5B57] bg-[#F6F5F1] hover:bg-[#ECEAE3] border border-[#D8D5CD] rounded whitespace-nowrap shrink-0"
                              >
                                驳回
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 11-point Audit Feedback Events */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[#141413]">
                  11 项 AI 操作与人工修正全链路审计日志 ({data.feedbackEvents.length})
                </h3>
                {data.feedbackEvents.length === 0 ? (
                  <div className="border border-[#E4E2DC] rounded-lg p-6 text-center text-xs text-[#78756E]">
                    尚无操作记录。执行 AI 对话指令或手工修改纸格后将自动记录全部 11 项反馈指标。
                  </div>
                ) : (
                  <div className="divide-y divide-[#ECEAE3] border border-[#E4E2DC] rounded-lg">
                    {data.feedbackEvents.map((fb) => (
                      <div key={fb.id} className="p-3.5 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-4">
                          <span className="font-medium text-[#141413]">
                            原始指令：{fb.userOriginalPrompt}
                          </span>
                          <span className="font-mono tabular-nums text-[#78756E] shrink-0">
                            {new Date(fb.createdAt).toLocaleString('zh-CN')}
                          </span>
                        </div>
                        <div className="text-[#5C5B57]">
                          解析任务：{fb.interpretedTask} · 几何变更：
                          {fb.geometryDiffSummary.join('；') || '无'}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-[#78756E] flex flex-wrap gap-x-2">
                          <span>引用知识 {fb.retrievedKnowledgeIds.length} 条</span>
                          <span aria-hidden="true">·</span>
                          <span>引用案例 {fb.usedCaseIds.length} 例</span>
                          <span aria-hidden="true">·</span>
                          <span className={fb.validationPassed ? 'text-[#16A34A]' : 'text-[#DC2626]'}>
                            校验{fb.validationPassed ? '通过' : '失败'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{fb.patternMakerCorrected ? '含打版师人工修正' : 'AI 自动执行'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: 10-Capability Fixed Regression Evaluation Gate */}
          {!loading && data && tab === 'evaluation' && (
            <div className="space-y-6">
              <div className="border border-[#E4E2DC] bg-[#FAF9F6] rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-[#141413]">
                    AI 工程能力固定测试集与回归发布门禁（10 项能力）
                  </h3>
                  <p className="text-xs text-[#5C5B57] mt-1">
                    每次模型、知识库或工艺规则升级均须运行回归评估。若任意指标低于历史基线，系统自动阻断部署。
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyAction === 'eval'}
                  onClick={handleRunEvaluation}
                  className="px-4 py-2 text-xs font-medium text-white bg-[#9A4D22] hover:bg-[#823F1A] disabled:opacity-50 rounded flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {busyAction === 'eval' ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      正在运行 10 项测试...
                    </>
                  ) : (
                    '运行 10 项能力回归测试'
                  )}
                </button>
              </div>

              {evalSummary && (
                <div
                  className={`border rounded-lg p-4 flex items-center justify-between gap-4 ${
                    evalSummary.allowedToDeploy
                      ? 'border-[#16A34A]/40 bg-[#F0FDF4]'
                      : 'border-[#DC2626]/40 bg-[#FEF2F2]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 text-xs">
                    {evalSummary.allowedToDeploy ? (
                      <ShieldCheck className="w-5 h-5 text-[#16A34A] shrink-0" />
                    ) : (
                      <ShieldAlert className="w-5 h-5 text-[#DC2626] shrink-0" />
                    )}
                    <div>
                      <div className="font-semibold text-[#141413]">
                        {evalSummary.allowedToDeploy
                          ? '回归门禁通过 · 允许部署新知识库/模型'
                          : '检测到能力退化 · 已禁止直接部署'}
                      </div>
                      <div className="text-[#5C5B57] font-mono tabular-nums mt-0.5">
                        运行批次 {evalSummary.runId} · 版本 {evalSummary.knowledgeVersionTag} ·
                        通过 {evalSummary.passedCount}/{evalSummary.totalTests} · 平均得分{' '}
                        {evalSummary.avgScore}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="border border-[#E4E2DC] rounded-lg overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#FAF9F6] border-b border-[#E4E2DC] text-[#5C5B57]">
                      <th className="py-2.5 px-4 font-medium">能力维度</th>
                      <th className="py-2.5 px-4 font-medium">测试用例</th>
                      <th className="py-2.5 px-4 font-medium text-right">基线分</th>
                      <th className="py-2.5 px-4 font-medium text-right">最新得分</th>
                      <th className="py-2.5 px-4 font-medium">观测结果</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#ECEAE3]">
                    {data.evalDatasets.map((ds) => {
                      const latest =
                        evalSummary?.results.find((r) => r.datasetId === ds.id) ??
                        data.latestEvalResults.find((r) => r.datasetId === ds.id);
                      return (
                        <tr key={ds.id} className="hover:bg-[#FAF9F6]/60">
                          <td className="py-2.5 px-4 font-mono text-[#5C5B57] whitespace-nowrap">
                            {ds.category}
                          </td>
                          <td className="py-2.5 px-4 font-medium text-[#141413]">
                            {ds.name}
                          </td>
                          <td className="py-2.5 px-4 font-mono tabular-nums text-right text-[#5C5B57]">
                            {ds.baselineScore.toFixed(2)}
                          </td>
                          <td
                            className={`py-2.5 px-4 font-mono tabular-nums text-right font-semibold ${
                              !latest
                                ? 'text-[#78756E]'
                                : latest.passed && !latest.regressionDetected
                                  ? 'text-[#16A34A]'
                                  : 'text-[#DC2626]'
                            }`}
                          >
                            {latest ? latest.score.toFixed(2) : '未运行'}
                          </td>
                          <td className="py-2.5 px-4 text-[#5C5B57]">
                            {latest ? latest.details.observedSummary : ds.inputPrompt}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
