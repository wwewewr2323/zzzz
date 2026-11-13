import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Layers,
  Plus,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import {
  buildQualityAssessmentReport,
  computeSmartNesting,
} from '../shared/cadEngine';
import {
  EDGE_PROCESS_LABELS,
  KNOWLEDGE_BASE_META,
  MATERIAL_LIBRARY,
  PROCESS_SCHEMES,
  computeThicknessCompensationMm,
  getMaterialById,
} from '../shared/leatherKnowledge';
import type {
  EdgeProcessType,
  EdgeRule,
  PatternPiece,
  Project,
  SeamType,
  StructuredCadCommand,
} from '../shared/types';

interface InspectorPanelProps {
  project: Project;
  selectedPieceId: string | null;
  proMode: boolean;
  onToggleProMode: (pro: boolean) => void;
  onSelectPiece: (id: string) => void;
  onApplyParameters: (payload: {
    widthMm: number;
    heightMm: number;
    depthMm: number;
    handleLengthMm: number;
    bottomThicknessMm: number;
    seamAllowanceMm: number;
    materialId: string;
    edgeProcess: EdgeProcessType;
  }) => Promise<void>;
  onCalibrateScale: (axis: 'width' | 'height' | 'depth', actualMm: number) => Promise<void>;
  onUpdatePieceEdges: (piece: PatternPiece, edges: EdgeRule[]) => Promise<void>;
  onAddCustomPiece: (name: string, w: number, h: number, allowance: number) => Promise<void>;
  onAutoFixIssue: (cmd: StructuredCadCommand) => Promise<void>;
  onRunValidation: () => Promise<void>;
  onApplyNesting: () => Promise<void>;
  onUpdateQualitySignoff: (payload: {
    patternMakerConfirmed?: boolean;
    patternMakerName?: string;
    physicalSamplePassed?: boolean;
    sampleLotNote?: string;
  }) => Promise<void>;
}

type TabKey = 'params' | 'parts' | 'validation';

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  project,
  selectedPieceId,
  proMode,
  onToggleProMode,
  onSelectPiece,
  onApplyParameters,
  onCalibrateScale,
  onUpdatePieceEdges,
  onAddCustomPiece,
  onAutoFixIssue,
  onRunValidation,
  onApplyNesting,
  onUpdateQualitySignoff,
}) => {
  const [tab, setTab] = useState<TabKey>('params');

  const [widthMm, setWidthMm] = useState(project.dimensions.widthMm);
  const [heightMm, setHeightMm] = useState(project.dimensions.heightMm);
  const [depthMm, setDepthMm] = useState(project.dimensions.depthMm);
  const [handleLengthMm, setHandleLengthMm] = useState(project.dimensions.handleLengthMm);
  const [bottomThicknessMm, setBottomThicknessMm] = useState(
    project.dimensions.bottomThicknessMm
  );
  const [seamAllowanceMm, setSeamAllowanceMm] = useState(project.dimensions.seamAllowanceMm);
  const [materialId, setMaterialId] = useState(project.materialId);
  const [edgeProcess, setEdgeProcess] = useState<EdgeProcessType>(project.edgeProcess);

  // Scale calibration state
  const [calAxis, setCalAxis] = useState<'width' | 'height' | 'depth'>('width');
  const [calActualMm, setCalActualMm] = useState(String(project.dimensions.widthMm));

  // Manual piece creator state (Pro CAD Mode)
  const [showNewPiece, setShowNewPiece] = useState(false);
  const [newPieceName, setNewPieceName] = useState('自定义配件片');
  const [newPieceW, setNewPieceW] = useState(120);
  const [newPieceH, setNewPieceH] = useState(80);
  const [newPieceSa, setNewPieceSa] = useState(5);

  // Knowledge base & signoff state (Pro CAD Mode)
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [isApplyingNest, setIsApplyingNest] = useState(false);
  const [makerName, setMakerName] = useState(
    project.qualitySignoff?.patternMakerName || '陈工'
  );
  const [sampleNote, setSampleNote] = useState(
    project.qualitySignoff?.sampleLotNote || ''
  );
  const [isUpdatingSignoff, setIsUpdatingSignoff] = useState(false);

  useEffect(() => {
    setWidthMm(project.dimensions.widthMm);
    setHeightMm(project.dimensions.heightMm);
    setDepthMm(project.dimensions.depthMm);
    setHandleLengthMm(project.dimensions.handleLengthMm);
    setBottomThicknessMm(project.dimensions.bottomThicknessMm);
    setSeamAllowanceMm(project.dimensions.seamAllowanceMm);
    setMaterialId(project.materialId);
    setEdgeProcess(project.edgeProcess);
    if (project.qualitySignoff?.patternMakerName) {
      setMakerName(project.qualitySignoff.patternMakerName);
    }
    if (project.qualitySignoff?.sampleLotNote !== undefined) {
      setSampleNote(project.qualitySignoff.sampleLotNote);
    }
  }, [project]);

  const currentMat = getMaterialById(materialId);
  const selectedPiece = project.patterns.find((p) => p.id === selectedPieceId) || null;
  const issueCount = project.validation.errorCount + project.validation.warningCount;

  const thicknessComp = useMemo(
    () => computeThicknessCompensationMm(materialId, edgeProcess),
    [materialId, edgeProcess]
  );

  const nestingSummary = useMemo(
    () =>
      computeSmartNesting(
        project.patterns,
        project.materialId,
        project.hardware
      ),
    [project.patterns, project.materialId, project.hardware]
  );

  const qualityReport = useMemo(
    () => buildQualityAssessmentReport(project),
    [project]
  );

  return (
    <aside className="w-full lg:w-[340px] shrink-0 bg-[#FFFFFF] border-l border-[#E4E2DC] flex flex-col h-full min-h-0">
      {/* Mode Switch Header (Simple Mode default vs. Professional CAD Mode) */}
      <div className="px-3 pt-2.5 pb-2 border-b border-[#ECEAE3] bg-[#FAF9F6] shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[#5C5B57] whitespace-nowrap shrink-0">
            工作区视图
          </span>
          <div className="inline-flex bg-[#ECEAE3] p-0.5 rounded shrink-0">
            <button
              type="button"
              onClick={() => onToggleProMode(false)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                !proMode
                  ? 'bg-white text-[#141413] shadow-xs'
                  : 'text-[#5C5B57] hover:text-[#141413]'
              }`}
            >
              简单模式
            </button>
            <button
              type="button"
              onClick={() => onToggleProMode(true)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                proMode
                  ? 'bg-[#141413] text-white shadow-xs'
                  : 'text-[#5C5B57] hover:text-[#141413]'
              }`}
            >
              专业 CAD
            </button>
          </div>
        </div>
        <p className="text-[11px] text-[#78756E] leading-tight">
          {proMode
            ? '已展开节点编辑、边缝份规则、智能排料、工程知识库及打版签核。'
            : '当前为精简设计视图，可直接通过左侧 AI 对话修改尺寸与结构。'}
        </p>

        {/* Segmented Inspector Tabs */}
        <div className="grid grid-cols-3 gap-1 bg-[#ECEAE3] p-0.5 rounded">
          <button
            type="button"
            onClick={() => setTab('params')}
            className={`py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              tab === 'params'
                ? 'bg-white text-[#141413] shadow-xs'
                : 'text-[#5C5B57] hover:text-[#141413]'
            }`}
          >
            {proMode ? '参数与排料' : '尺寸与材料'}
          </button>
          <button
            type="button"
            onClick={() => setTab('parts')}
            className={`py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              tab === 'parts'
                ? 'bg-white text-[#141413] shadow-xs'
                : 'text-[#5C5B57] hover:text-[#141413]'
            }`}
          >
            部件 ({project.patterns.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('validation')}
            className={`py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              tab === 'validation'
                ? 'bg-white text-[#141413] shadow-xs'
                : 'text-[#5C5B57] hover:text-[#141413]'
            }`}
          >
            质量报告 {issueCount > 0 ? `(${issueCount})` : ''}
          </button>
        </div>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {tab === 'params' && (
          <>
            {/* Dimension Source Warning / Calibration */}
            <div className="pb-4 border-b border-[#ECEAE3] space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#141413]">尺寸数据来源</span>
                <span
                  className={`font-medium ${
                    project.dimensions.dimensionSource === 'ai_estimated'
                      ? 'text-[#D97706]'
                      : 'text-[#16A34A]'
                  }`}
                >
                  {project.dimensions.dimensionSource === 'ai_estimated'
                    ? 'AI 估算版型'
                    : project.dimensions.dimensionSource === 'scale_calibrated'
                      ? '比例尺校准'
                      : '已确认尺寸'}
                </span>
              </div>
              {project.dimensions.dimensionSource === 'ai_estimated' && (
                <p className="text-[11px] text-[#78756E] leading-relaxed">
                  当前尺寸为依据照片比例估算。输入任一实际尺寸即可按比例尺整体校准：
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <select
                  value={calAxis}
                  onChange={(e) =>
                    setCalAxis(e.target.value as 'width' | 'height' | 'depth')
                  }
                  className="text-xs border border-[#D8D5CD] rounded px-2 py-1.5 bg-[#FAF9F6]"
                >
                  <option value="width">包宽</option>
                  <option value="height">包高</option>
                  <option value="depth">侧面深</option>
                </select>
                <input
                  type="number"
                  value={calActualMm}
                  onChange={(e) => setCalActualMm(e.target.value)}
                  className="w-20 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded px-2 py-1.5 bg-white"
                  placeholder="mm"
                />
                <button
                  type="button"
                  onClick={() => {
                    const val = Number(calActualMm);
                    if (val > 20) onCalibrateScale(calAxis, val);
                  }}
                  className="px-2.5 py-1.5 text-xs font-medium bg-[#F6F5F1] hover:bg-[#ECEAE3] border border-[#D8D5CD] rounded whitespace-nowrap shrink-0"
                >
                  等比校准
                </button>
              </div>
            </div>

            {/* Primary Parametric Dimensions */}
            <div className="pb-4 border-b border-[#ECEAE3] space-y-3">
              <div className="text-xs font-semibold text-[#141413]">核心结构尺寸 (mm)</div>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="text-[11px] text-[#5C5B57]">包宽 (W)</span>
                  <input
                    type="number"
                    value={widthMm}
                    onChange={(e) => setWidthMm(Number(e.target.value))}
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-[#5C5B57]">包高 (H)</span>
                  <input
                    type="number"
                    value={heightMm}
                    onChange={(e) => setHeightMm(Number(e.target.value))}
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-[#5C5B57]">侧面深 (D)</span>
                  <input
                    type="number"
                    value={depthMm}
                    onChange={(e) => setDepthMm(Number(e.target.value))}
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-[#5C5B57]">提手总长</span>
                  <input
                    type="number"
                    value={handleLengthMm}
                    onChange={(e) => setHandleLengthMm(Number(e.target.value))}
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                  />
                </label>
                {proMode && (
                  <>
                    <label className="block">
                      <span className="text-[11px] text-[#5C5B57]">包底厚 (mm)</span>
                      <input
                        type="number"
                        step="0.2"
                        value={bottomThicknessMm}
                        onChange={(e) => setBottomThicknessMm(Number(e.target.value))}
                        className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-[#5C5B57]">默认缝份 (mm)</span>
                      <input
                        type="number"
                        step="0.5"
                        value={seamAllowanceMm}
                        onChange={(e) => setSeamAllowanceMm(Number(e.target.value))}
                        className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                      />
                    </label>
                  </>
                )}
              </div>
            </div>

            {/* Material & Process */}
            <div className="pb-4 border-b border-[#ECEAE3] space-y-3">
              <div className="text-xs font-semibold text-[#141413]">皮料与工艺参数</div>
              <label className="block">
                <span className="text-[11px] text-[#5C5B57]">主面皮料</span>
                <select
                  value={materialId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setMaterialId(nextId);
                    const m = getMaterialById(nextId);
                    setEdgeProcess(m.recommendedEdgeProcess);
                    setSeamAllowanceMm(m.defaultSeamAllowanceMm);
                  }}
                  className="mt-1 w-full px-2.5 py-1.5 text-xs border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                >
                  {MATERIAL_LIBRARY.filter(
                    (m) => m.category !== 'lining' && m.category !== 'reinforcement'
                  ).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.thicknessMm}mm)
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[11px] text-[#5C5B57]">包口边缘工艺</span>
                <select
                  value={edgeProcess}
                  onChange={(e) => setEdgeProcess(e.target.value as EdgeProcessType)}
                  className="mt-1 w-full px-2.5 py-1.5 text-xs border border-[#D8D5CD] rounded bg-[#FAF9F6]"
                >
                  {Object.entries(EDGE_PROCESS_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="text-[11px] text-[#5C5B57] bg-[#FAF9F6] border border-[#ECEAE3] rounded p-2.5 space-y-1">
                <div>
                  厚度 <span className="font-mono">{currentMat.thicknessMm}mm</span> · 挺度{' '}
                  {currentMat.temper === 'firm'
                    ? '硬挺定型'
                    : currentMat.temper === 'medium'
                      ? '中等弹性'
                      : '柔软垂坠'}{' '}
                  · 推荐针距 <span className="font-mono">{currentMat.stitchSpacingMm}mm</span>
                </div>
                <div className="text-[#78756E]">{currentMat.description}</div>
              </div>

              {proMode && (
                <div className="text-[11px] bg-[#FAF9F6] border border-[#E4E2DC] rounded p-2.5 space-y-1">
                  <div className="font-semibold text-[#141413]">
                    厚度补偿实时计算（已联动生成）
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[#5C5B57] font-mono tabular-nums">
                    <span>内衬宽缩量：-{thicknessComp.liningWidthDeductionMm}mm</span>
                    <span>内衬高缩量：-{thicknessComp.liningHeightDeductionMm}mm</span>
                    <span>底板内缩：-{thicknessComp.boardInsetMm}mm</span>
                    <span>折弯余量：+{thicknessComp.bendRadiusAllowanceMm}mm</span>
                  </div>
                  <div
                    className={
                      thicknessComp.skiveRequired ? 'text-[#D97706]' : 'text-[#5C5B57]'
                    }
                  >
                    {thicknessComp.skiveRequired
                      ? `需边缘铲薄至 ${thicknessComp.skiveTargetMm}mm 后折边`
                      : `当前工艺可按目标厚度 ${thicknessComp.skiveTargetMm}mm 控薄`}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() =>
                  onApplyParameters({
                    widthMm,
                    heightMm,
                    depthMm,
                    handleLengthMm,
                    bottomThicknessMm,
                    seamAllowanceMm,
                    materialId,
                    edgeProcess,
                  })
                }
                className="w-full py-2 text-xs font-medium text-white bg-[#141413] hover:bg-[#2C2C2A] rounded transition-colors"
              >
                应用参数并同步联动纸格
              </button>
            </div>

            {/* Pro Mode Only: Smart Grain-Aware Nesting & Material Cost */}
            {proMode && project.patterns.length > 0 && (
              <div className="pb-4 border-b border-[#ECEAE3] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-[#9A4D22]" />
                    智能排料与物料估算
                  </span>
                  <span className="text-xs font-mono tabular-nums font-semibold text-[#16A34A]">
                    利用率 {nestingSummary.utilizationPct}%
                  </span>
                </div>

                <div className="bg-[#FAF9F6] border border-[#ECEAE3] rounded p-2.5 text-[11px] space-y-1.5">
                  <div className="flex items-center justify-between text-[#5C5B57]">
                    <span>标准皮料幅面</span>
                    <span className="font-mono tabular-nums">
                      {nestingSummary.hideWidthMm}×{nestingSummary.hideHeightMm}mm
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[#5C5B57]">
                    <span>净片展开面积 / 锁定纹向</span>
                    <span className="font-mono tabular-nums">
                      {nestingSummary.netPiecesAreaDm2} dm² · {nestingSummary.grainLockedCount}/
                      {nestingSummary.totalPieceCuts} 片
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[#5C5B57]">
                    <span>预估主皮 + 五金物料费</span>
                    <span className="font-mono tabular-nums text-[#141413] font-medium">
                      ¥{nestingSummary.estimatedLeatherCostCny} + ¥
                      {nestingSummary.estimatedHardwareCostCny} = ¥
                      {nestingSummary.estimatedTotalMaterialCostCny}
                    </span>
                  </div>
                  <div className="text-[#78756E] leading-relaxed pt-1 border-t border-[#ECEAE3]">
                    {nestingSummary.notes.join(' ')}
                  </div>
                  {nestingSummary.unplacedPieces.length > 0 && (
                    <div className="text-[#DC2626] font-medium">
                      超出单张幅面：{nestingSummary.unplacedPieces.join(', ')}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={isApplyingNest}
                  onClick={async () => {
                    setIsApplyingNest(true);
                    try {
                      await onApplyNesting();
                    } finally {
                      setIsApplyingNest(false);
                    }
                  }}
                  className="w-full py-1.5 text-xs font-medium text-[#9A4D22] bg-[#FAF6F2] hover:bg-[#F3EBE2] border border-[#9A4D22]/30 rounded transition-colors disabled:opacity-50"
                >
                  {isApplyingNest ? '正在排料...' : '一键应用纹理排料到画布'}
                </button>
              </div>
            )}

            {/* Pro Mode Only: Auditable Leather Engineering Knowledge Base */}
            {proMode && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowKnowledgeBase((v) => !v)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-[#141413] py-1"
                >
                  <span className="flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-[#9A4D22]" />
                    皮具工程知识库 ({KNOWLEDGE_BASE_META.version})
                  </span>
                  {showKnowledgeBase ? (
                    <ChevronUp className="w-3.5 h-3.5 text-[#78756E]" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-[#78756E]" />
                  )}
                </button>

                {showKnowledgeBase && (
                  <div className="bg-[#FAF9F6] border border-[#ECEAE3] rounded p-2.5 text-[11px] space-y-2.5">
                    <div className="space-y-1">
                      <div className="font-semibold text-[#141413]">适用范围与标准来源</div>
                      <div className="text-[#5C5B57]">{KNOWLEDGE_BASE_META.applicabilityScope}</div>
                      <ul className="list-disc pl-4 text-[#78756E] space-y-0.5">
                        {KNOWLEDGE_BASE_META.sources.map((src) => (
                          <li key={src}>{src}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="space-y-1 pt-2 border-t border-[#ECEAE3]">
                      <div className="font-semibold text-[#141413]">工艺方案库（4 套标准）</div>
                      {PROCESS_SCHEMES.map((sch) => (
                        <div key={sch.id} className="text-[#5C5B57] leading-snug">
                          <span className="font-medium text-[#141413]">{sch.name}</span>：缝份{' '}
                          <span className="font-mono">{sch.seamAllowanceMm}mm</span> · 针距{' '}
                          <span className="font-mono">{sch.stitchSpacingMm}mm</span>（{sch.sourceStandard}）
                        </div>
                      ))}
                    </div>

                    <div className="space-y-1 pt-2 border-t border-[#ECEAE3]">
                      <div className="font-semibold text-[#141413]">专业人员审核记录</div>
                      {KNOWLEDGE_BASE_META.auditLog.map((entry) => (
                        <div key={entry.reviewer} className="text-[#78756E]">
                          {entry.date} · {entry.reviewer}（{entry.role}）：{entry.note}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'parts' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#141413]">独立二维纸格清单</span>
              {proMode && (
                <button
                  type="button"
                  onClick={() => setShowNewPiece((v) => !v)}
                  className="text-xs font-medium text-[#9A4D22] hover:underline flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  手工新增纸格
                </button>
              )}
            </div>

            {proMode && showNewPiece && (
              <div className="border border-[#D8D5CD] bg-[#FAF9F6] rounded p-3 space-y-2.5">
                <div className="text-xs font-medium text-[#141413]">手工创建矩形裁片</div>
                <input
                  type="text"
                  value={newPieceName}
                  onChange={(e) => setNewPieceName(e.target.value)}
                  placeholder="裁片名称"
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-[#D8D5CD] rounded"
                />
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-[11px] text-[#5C5B57]">
                    宽(mm)
                    <input
                      type="number"
                      value={newPieceW}
                      onChange={(e) => setNewPieceW(Number(e.target.value))}
                      className="mt-0.5 w-full px-2 py-1 text-xs font-mono bg-white border border-[#D8D5CD] rounded"
                    />
                  </label>
                  <label className="text-[11px] text-[#5C5B57]">
                    高(mm)
                    <input
                      type="number"
                      value={newPieceH}
                      onChange={(e) => setNewPieceH(Number(e.target.value))}
                      className="mt-0.5 w-full px-2 py-1 text-xs font-mono bg-white border border-[#D8D5CD] rounded"
                    />
                  </label>
                  <label className="text-[11px] text-[#5C5B57]">
                    缝份(mm)
                    <input
                      type="number"
                      value={newPieceSa}
                      onChange={(e) => setNewPieceSa(Number(e.target.value))}
                      className="mt-0.5 w-full px-2 py-1 text-xs font-mono bg-white border border-[#D8D5CD] rounded"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      await onAddCustomPiece(
                        newPieceName.trim() || '自定义裁片',
                        Math.max(20, newPieceW),
                        Math.max(20, newPieceH),
                        Math.max(0, newPieceSa)
                      );
                      setShowNewPiece(false);
                    }}
                    className="px-3 py-1 text-xs font-medium bg-[#9A4D22] text-white rounded"
                  >
                    创建裁片
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowNewPiece(false)}
                    className="px-2 py-1 text-xs text-[#5C5B57]"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-[#ECEAE3]">
              {project.patterns.map((piece) => {
                const isSel = piece.id === selectedPieceId;
                return (
                  <div
                    key={piece.id}
                    onClick={() => onSelectPiece(piece.id)}
                    className={`py-2.5 px-2 rounded cursor-pointer transition-colors ${
                      isSel ? 'bg-[#FAF6F2]' : 'hover:bg-[#FAF9F6]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-[#141413] truncate">
                        <span className="font-mono text-[#9A4D22] mr-1.5">
                          {piece.partCode}
                        </span>
                        {piece.name.split(' ')[0]}
                      </div>
                      <span className="text-xs font-mono tabular-nums text-[#5C5B57] shrink-0">
                        ×{piece.quantity}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#78756E] font-mono tabular-nums">
                      <span>
                        {piece.boundingBoxMm.width}×{piece.boundingBoxMm.height}mm
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{piece.thicknessMm}mm</span>
                      {piece.isInferredHidden && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#D97706] font-sans">推断结构</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pro Mode Only: Selected Piece Per-Edge Seam Allowance Editor */}
            {proMode && selectedPiece && (
              <div className="pt-3 border-t border-[#E4E2DC] space-y-2.5">
                <div className="text-xs font-semibold text-[#141413]">
                  独立边缝份规则：{selectedPiece.partCode}
                </div>
                <div className="space-y-2">
                  {selectedPiece.edges.map((edge, idx) => (
                    <div
                      key={edge.edgeId}
                      className="p-2 bg-[#FAF9F6] border border-[#ECEAE3] rounded text-xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[#141413]">{edge.label}</span>
                        <span className="font-mono tabular-nums text-[11px] text-[#5C5B57]">
                          {selectedPiece.edgeLengthsMm[edge.edgeId] ?? 0} mm
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={edge.seamType}
                          onChange={(e) => {
                            const nextEdges = selectedPiece.edges.map((ed, i) =>
                              i === idx
                                ? { ...ed, seamType: e.target.value as SeamType }
                                : ed
                            );
                            onUpdatePieceEdges(selectedPiece, nextEdges);
                          }}
                          className="px-1.5 py-1 text-[11px] bg-white border border-[#D8D5CD] rounded"
                        >
                          <option value="plain">平缝</option>
                          <option value="folded">折边</option>
                          <option value="raw">原边净裁</option>
                          <option value="piped">滚边</option>
                        </select>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            step="0.5"
                            min={0}
                            max={20}
                            value={
                              edge.seamType === 'folded'
                                ? edge.foldWidthMm
                                : edge.allowanceMm
                            }
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              const nextEdges = selectedPiece.edges.map((ed, i) =>
                                i === idx
                                  ? edge.seamType === 'folded'
                                    ? { ...ed, foldWidthMm: val }
                                    : { ...ed, allowanceMm: val }
                                  : ed
                              );
                              onUpdatePieceEdges(selectedPiece, nextEdges);
                            }}
                            className="w-full px-1.5 py-1 text-[11px] font-mono bg-white border border-[#D8D5CD] rounded"
                          />
                          <span className="text-[11px] text-[#78756E]">mm</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'validation' && (
          <div className="space-y-4">
            {/* 4 Strictly Separated Engineering Verification States */}
            <div className="space-y-2 pb-3 border-b border-[#ECEAE3]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#141413]">
                  四重工程验证状态
                </span>
                <button
                  type="button"
                  onClick={onRunValidation}
                  className="text-xs text-[#9A4D22] hover:underline whitespace-nowrap shrink-0"
                >
                  重新校验
                </button>
              </div>
              <div className="divide-y divide-[#ECEAE3] bg-[#FAF9F6] border border-[#ECEAE3] rounded px-2.5 text-xs">
                <div className="py-2 flex items-center justify-between gap-2">
                  <span className="text-[#141413]">1. 几何验证（自动）</span>
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      qualityReport.geometryVerified
                        ? 'text-[#16A34A]'
                        : 'text-[#DC2626]'
                    }`}
                  >
                    {qualityReport.geometryVerified ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5" />
                    )}
                    {qualityReport.geometryVerified ? '已通过几何验证' : '存在几何错误'}
                  </span>
                </div>
                <div className="py-2 flex items-center justify-between gap-2">
                  <span className="text-[#141413]">2. 工艺规则（自动）</span>
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      qualityReport.processRuleVerified
                        ? 'text-[#16A34A]'
                        : 'text-[#D97706]'
                    }`}
                  >
                    {qualityReport.processRuleVerified ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <Clock className="w-3.5 h-3.5" />
                    )}
                    {qualityReport.processRuleVerified
                      ? '已通过工艺规则检查'
                      : '待尺寸确认或工艺复核'}
                  </span>
                </div>
                <div className="py-2 flex items-center justify-between gap-2">
                  <span className="text-[#141413]">3. 打版师确认（人工）</span>
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      qualityReport.patternMakerConfirmed
                        ? 'text-[#16A34A]'
                        : 'text-[#78756E]'
                    }`}
                  >
                    {qualityReport.patternMakerConfirmed ? (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    ) : (
                      <Clock className="w-3.5 h-3.5" />
                    )}
                    {qualityReport.patternMakerConfirmed
                      ? `已由 ${project.qualitySignoff?.patternMakerName || '打版师'} 确认`
                      : '待人工复核'}
                  </span>
                </div>
                <div className="py-2 flex items-center justify-between gap-2">
                  <span className="text-[#141413]">4. 实物样品制作（车间）</span>
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      qualityReport.physicalSamplePassed
                        ? 'text-[#16A34A]'
                        : 'text-[#78756E]'
                    }`}
                  >
                    {qualityReport.physicalSamplePassed ? (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    ) : (
                      <Clock className="w-3.5 h-3.5" />
                    )}
                    {qualityReport.physicalSamplePassed
                      ? '已通过实际样品制作'
                      : '未进行实物试制'}
                  </span>
                </div>
              </div>
            </div>

            {/* 8-Dimension Quality Evaluation */}
            <div className="space-y-1.5 pb-3 border-b border-[#ECEAE3] text-[11px]">
              <div className="text-xs font-semibold text-[#141413]">8 项质量评估明细</div>
              <div className="space-y-1 text-[#5C5B57]">
                <div>
                  <span className="font-medium text-[#141413]">几何结构：</span>
                  {qualityReport.geometryStatus}
                </div>
                <div>
                  <span className="font-medium text-[#141413]">部件完整性：</span>
                  {qualityReport.componentCompleteness}
                </div>
                <div>
                  <span className="font-medium text-[#141413]">接缝匹配：</span>
                  {qualityReport.seamMatchStatus}
                </div>
                <div>
                  <span className="font-medium text-[#141413]">尺寸校准：</span>
                  {qualityReport.dimensionCalibrationStatus}
                </div>
                <div>
                  <span className="font-medium text-[#141413]">缝份检查：</span>
                  {qualityReport.seamAllowanceStatus}
                </div>
                <div>
                  <span className="font-medium text-[#141413]">材料工艺：</span>
                  {qualityReport.materialCompatibilityStatus}
                </div>
                {qualityReport.unconfirmedStructures.length > 0 && (
                  <div className="text-[#D97706]">
                    <span className="font-medium">未确认隐藏结构：</span>
                    {qualityReport.unconfirmedStructures.join('、')}
                  </div>
                )}
                {qualityReport.productionRisks.length > 0 && (
                  <div className="text-[#DC2626] space-y-0.5 pt-1">
                    <div className="font-medium">生产风险提示：</div>
                    {qualityReport.productionRisks.map((risk) => (
                      <div key={risk}>· {risk}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Detailed Validation Issues + 1-Click AutoFix */}
            {project.validation.issues.length === 0 ? (
              <div className="py-3 text-center text-xs text-[#16A34A]">
                所有纸格轮廓闭合、缝份有效、接缝长度误差均在 ±1.2mm 以内。
              </div>
            ) : (
              <div className="space-y-2.5">
                {project.validation.issues.map((issue) => (
                  <div
                    key={issue.id}
                    className={`p-3 rounded border text-xs space-y-1.5 ${
                      issue.severity === 'error'
                        ? 'border-[#DC2626]/30 bg-[#FEF2F2]'
                        : 'border-[#D97706]/30 bg-[#FFFBEB]'
                    }`}
                  >
                    <div className="font-semibold text-[#141413] flex items-center justify-between gap-2">
                      <span>
                        {issue.severity === 'error' ? '[错误] ' : '[工艺提示] '}
                        {issue.title}
                      </span>
                      {issue.diffMm != null && (
                        <span className="font-mono tabular-nums text-[#DC2626] shrink-0">
                          {issue.diffMm > 0 ? `+${issue.diffMm}` : issue.diffMm}mm
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#5C5B57] leading-relaxed">
                      {issue.detail}
                    </p>
                    {issue.suggestedAction && (
                      <p className="text-[11px] text-[#141413]">
                        建议：{issue.suggestedAction}
                      </p>
                    )}
                    {issue.autoFixCommand && (
                      <button
                        type="button"
                        onClick={() => onAutoFixIssue(issue.autoFixCommand!)}
                        className="mt-1 px-2.5 py-1 text-[11px] font-medium bg-[#141413] text-white rounded flex items-center gap-1"
                      >
                        <Wrench className="w-3 h-3" />
                        一键校准接缝长度
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Pro Mode Only: Patternmaker & Physical Sample Signoff Controls */}
            {proMode && (
              <div className="pt-3 border-t border-[#E4E2DC] space-y-2.5">
                <div className="text-xs font-semibold text-[#141413]">
                  专业打版签核与样品记录
                </div>
                <p className="text-[11px] text-[#78756E] leading-relaxed">
                  任何尺寸、几何或皮料改动都会自动作废历史签核，确保版型与实物严格一致。
                </p>

                <div className="space-y-2 bg-[#FAF9F6] border border-[#ECEAE3] rounded p-2.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={makerName}
                      onChange={(e) => setMakerName(e.target.value)}
                      placeholder="打版师姓名"
                      className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-[#D8D5CD] rounded"
                    />
                    <button
                      type="button"
                      disabled={isUpdatingSignoff}
                      onClick={async () => {
                        setIsUpdatingSignoff(true);
                        try {
                          await onUpdateQualitySignoff({
                            patternMakerConfirmed: !qualityReport.patternMakerConfirmed,
                            patternMakerName: makerName.trim() || '陈工',
                          });
                        } finally {
                          setIsUpdatingSignoff(false);
                        }
                      }}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap shrink-0 ${
                        qualityReport.patternMakerConfirmed
                          ? 'bg-[#ECEAE3] text-[#141413]'
                          : 'bg-[#141413] text-white'
                      }`}
                    >
                      {qualityReport.patternMakerConfirmed ? '撤回打版确认' : '签署打版确认'}
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={sampleNote}
                      onChange={(e) => setSampleNote(e.target.value)}
                      placeholder="试样批号 / 试制备注"
                      className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-[#D8D5CD] rounded"
                    />
                    <button
                      type="button"
                      disabled={isUpdatingSignoff}
                      onClick={async () => {
                        setIsUpdatingSignoff(true);
                        try {
                          await onUpdateQualitySignoff({
                            physicalSamplePassed: !qualityReport.physicalSamplePassed,
                            sampleLotNote: sampleNote.trim() || '车间首件试制通过',
                          });
                        } finally {
                          setIsUpdatingSignoff(false);
                        }
                      }}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap shrink-0 ${
                        qualityReport.physicalSamplePassed
                          ? 'bg-[#ECEAE3] text-[#141413]'
                          : 'bg-[#9A4D22] text-white'
                      }`}
                    >
                      {qualityReport.physicalSamplePassed ? '撤回样品状态' : '标记样品通过'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
