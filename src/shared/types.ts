export type BagType = 'tote' | 'handbag' | 'shoulder_bag';

export type DimensionSource =
  | 'user_confirmed'
  | 'ai_estimated'
  | 'scale_calibrated'
  | 'computed';

export type ImageAngle = 'front' | 'back' | 'side' | 'bottom' | 'interior' | 'detail';

export interface ProductImage {
  id: string;
  name: string;
  angle: ImageAngle;
  dataUrl: string;
  mimeType: string;
  uploadedAt: string;
}

export type MaterialCategory =
  | 'veg_tan'
  | 'box_calf'
  | 'soft_calf'
  | 'pebbled_cowhide'
  | 'lambskin'
  | 'microfiber'
  | 'lining'
  | 'reinforcement';

export type EdgeProcessType =
  | 'raw_burnish'
  | 'edge_paint'
  | 'folded'
  | 'piped'
  | 'bound';

export interface MaterialSpec {
  id: string;
  name: string;
  category: MaterialCategory;
  thicknessMm: number;
  temper: 'soft' | 'medium' | 'firm';
  stretchFactor: number; // 0.0 - 0.15
  grainRequired: boolean;
  recommendedEdgeProcess: EdgeProcessType;
  defaultSeamAllowanceMm: number;
  defaultFoldWidthMm: number;
  stitchSpacingMm: number;
  skivingRecommendedAboveMm: number;
  costPerDm2Cny?: number;
  description: string;
}

export interface KnowledgeBaseMeta {
  version: string;
  updatedAt: string;
  sources: string[];
  applicabilityScope: string;
  auditLog: Array<{
    reviewer: string;
    role: string;
    date: string;
    note: string;
  }>;
}

export interface ProcessSchemeSpec {
  id: string;
  name: string;
  edgeProcess: EdgeProcessType;
  applicableTempers: Array<'soft' | 'medium' | 'firm'>;
  seamAllowanceMm: number;
  foldWidthMm: number;
  skiveEdgeTargetMm: number;
  stitchSpacingMm: number;
  reinforcementAdvice: string;
  sourceStandard: string;
}

export interface StandardComponentSpec {
  standardType: string;
  partCodePrefix: string;
  name: string;
  category: ComponentCategory;
  defaultSeamAllowanceMm: number;
  matingEdges: string[];
  productionNotes: string;
}

export interface HardwareSpec {
  id: string;
  name: string;
  type:
    | 'd_ring'
    | 'magnetic_snap'
    | 'zipper'
    | 'rivet'
    | 'turn_lock'
    | 'buckle'
    | 'strap_clip'
    | 'bottom_stud';
  mountWidthMm: number;
  holeDiameterMm: number;
  holeSpacingMm: number;
  quantity: number;
  finish: string;
  notes?: string;
}

export type ComponentCategory =
  | 'body'
  | 'handle'
  | 'strap'
  | 'opening'
  | 'interior'
  | 'edge'
  | 'hardware'
  | 'reinforcement';

export interface ComponentItem {
  id: string;
  partCode: string;
  name: string;
  standardType: string;
  category: ComponentCategory;
  role: string;
  quantity: number;
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  materialName: string;
  processType: EdgeProcessType;
  confidence: number; // 0..1
  source: DimensionSource;
  isInferredHidden: boolean;
  boundingBox2D?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000
  confirmed: boolean;
  notes?: string;
}

export interface ComponentRelation {
  id: string;
  fromComponentId: string;
  fromEdgeId: string;
  toComponentId: string;
  toEdgeId: string;
  relationType:
    | 'sew'
    | 'fold'
    | 'rivet'
    | 'hardware_mount'
    | 'lining_attach'
    | 'reinforce';
  stitchDirection: 'face_to_face' | 'lap' | 'edge_to_edge';
  allowanceMm: number;
  notes?: string;
}

export type SegmentType = 'move' | 'line' | 'quad' | 'cubic';

export interface PathNode {
  id: string;
  x: number;
  y: number;
  type: SegmentType;
  cx1?: number;
  cy1?: number;
  cx2?: number;
  cy2?: number;
}

export type SeamType = 'plain' | 'folded' | 'piped' | 'bound' | 'raw';

export interface EdgeRule {
  edgeId: string;
  label: string;
  nodeStartIdx: number;
  nodeEndIdx: number;
  seamType: SeamType;
  allowanceMm: number;
  foldWidthMm: number;
  stitchLineOffsetMm: number;
}

export interface PatternHole {
  id: string;
  x: number;
  y: number;
  diameterMm: number;
  kind: 'stitch' | 'rivet' | 'hardware' | 'buckle';
  label?: string;
}

export interface PatternNotch {
  id: string;
  x: number;
  y: number;
  nx: number; // outward normal x
  ny: number; // outward normal y
  depthMm: number;
  edgeId: string;
  label?: string;
}

export interface FoldLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface PatternPiece {
  id: string;
  componentId: string;
  partCode: string;
  name: string;
  category: ComponentCategory;
  quantity: number;
  materialId: string;
  materialName: string;
  thicknessMm: number;
  canvasX: number;
  canvasY: number;
  rotationDeg: number;
  nodes: PathNode[];
  edges: EdgeRule[];
  seamAllowanceMm: number;
  foldAllowanceMm: number;
  sewContour: Point2D[];
  cutContour: Point2D[];
  stitchContour: Point2D[];
  foldLines: FoldLine[];
  holes: PatternHole[];
  notches: PatternNotch[];
  grainAngleDeg: number;
  boundingBoxMm: { width: number; height: number };
  perimeterMm: number;
  areaMm2: number;
  edgeLengthsMm: Record<string, number>;
  confidence?: number;
  isInferredHidden?: boolean;
  manuallyEdited?: boolean;
  notes?: string;
}

export type GussetStyle = 'straight' | 'curved' | 'tapered';

export interface ProductDimensions {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  handleLengthMm: number;
  handleDropMm: number;
  strapLengthMm: number;
  bottomThicknessMm: number;
  gussetStyle: GussetStyle;
  gussetCurveRadiusMm: number;
  topOpeningCurveMm: number;
  cornerRadiusMm: number;
  seamAllowanceMm: number;
  foldWidthMm: number;
  stitchSpacingMm: number;
  dimensionSource: DimensionSource;
  calibrationNote?: string;
}

export interface EnabledFeatures {
  hasZipperPocket: boolean;
  hasFrontPocket: boolean;
  hasSlipPocket: boolean;
  hasTopZipperFlap: boolean;
  hasBottomBoard: boolean;
  hasShoulderStrap: boolean;
  hasMagneticClosure: boolean;
  hasTurnLock: boolean;
  hasLining: boolean;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  code: string;
  title: string;
  detail: string;
  pieceId?: string;
  pieceName?: string;
  edgeId?: string;
  targetPieceId?: string;
  targetPieceName?: string;
  targetEdgeId?: string;
  currentMm?: number;
  expectedMm?: number;
  diffMm?: number;
  suggestedAction?: string;
  autoFixCommand?: StructuredCadCommand;
}

export interface ValidationReport {
  checkedAt: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  issues: ValidationIssue[];
}

export type OptimizationGoal =
  | 'reduce_waste'
  | 'reduce_seams'
  | 'italian_luxury'
  | 'comfort_handle'
  | 'optimize_zipper';

export type CadCommandIntent =
  | 'resize_product'
  | 'resize_component'
  | 'modify_geometry'
  | 'add_component'
  | 'remove_component'
  | 'change_material'
  | 'calibrate_scale'
  | 'fix_seam_mismatch'
  | 'optimize_pattern'
  | 'apply_nesting'
  | 'undo_last'
  | 'redo_last'
  | 'design_advice'
  | 'run_validation';

export interface StructuredCadCommand {
  intent: CadCommandIntent;
  target: string;
  operation: string;
  parameters: {
    widthMm?: number;
    heightMm?: number;
    depthMm?: number;
    deltaWidthMm?: number;
    deltaHeightMm?: number;
    deltaDepthMm?: number;
    deltaLengthMm?: number;
    bottomThicknessMm?: number;
    gussetStyle?: GussetStyle;
    gussetCurveRadiusMm?: number;
    topOpeningCurveMm?: number;
    cornerRadiusMm?: number;
    componentType?:
      | 'zipper_pocket'
      | 'front_pocket'
      | 'slip_pocket'
      | 'top_zipper_flap'
      | 'bottom_board'
      | 'shoulder_strap'
      | 'magnetic_closure';
    pieceId?: string;
    edgeId?: string;
    targetLengthMm?: number;
    materialId?: string;
    edgeProcess?: EdgeProcessType;
    stitchSpacingMm?: number;
    seamAllowanceMm?: number;
    referenceAxis?: 'width' | 'height' | 'depth';
    actualMm?: number;
    optimizationGoal?: OptimizationGoal;
    hideWidthMm?: number;
    hideHeightMm?: number;
  };
}

export interface DesignOption {
  id: string;
  title: string;
  description: string;
  commands: StructuredCadCommand[];
}

export interface CommandPlan {
  planId: string;
  userPrompt: string;
  summary: string;
  replyText: string;
  needsConfirmation: boolean;
  isDestructiveOrMajor: boolean;
  clarifyingQuestion?: string;
  proposedOptions?: DesignOption[];
  commands: StructuredCadCommand[];
  affectedParts: string[];
  retrievedKnowledgeIds?: string[];
  usedCaseIds?: string[];
  memoryHints?: string[];
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  plan?: CommandPlan;
  planStatus?: 'pending_confirmation' | 'executed' | 'cancelled' | 'advice_only';
  diffSummary?: string[];
}

export interface AiAnalysisJob {
  id: string;
  projectId: string;
  status:
    | 'queued'
    | 'vision_analyzing'
    | 'structure_reasoning'
    | 'pattern_generating'
    | 'validating'
    | 'completed'
    | 'failed';
  progress: number;
  statusMessage: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QualitySignoff {
  patternMakerConfirmed: boolean;
  patternMakerName?: string;
  patternMakerAt?: string;
  physicalSamplePassed: boolean;
  sampleLotNote?: string;
  physicalSampleAt?: string;
}

export interface QualityReportSummary {
  // 4 strictly separated engineering verification states
  geometryVerified: boolean;
  processRuleVerified: boolean;
  patternMakerConfirmed: boolean;
  physicalSamplePassed: boolean;
  // 8 evaluation dimensions
  geometryStatus: string;
  componentCompleteness: string;
  seamMatchStatus: string;
  dimensionCalibrationStatus: string;
  seamAllowanceStatus: string;
  materialCompatibilityStatus: string;
  unconfirmedStructures: string[];
  productionRisks: string[];
}

export interface HideDefectZone {
  id: string;
  label: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PlacedNestItem {
  pieceId: string;
  partCode: string;
  name: string;
  copyIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotated90: boolean;
  grainAligned: boolean;
}

export interface NestingResult {
  hideWidthMm: number;
  hideHeightMm: number;
  usableAreaDm2: number;
  netPiecesAreaDm2: number;
  utilizationPct: number;
  totalPieceCuts: number;
  grainLockedCount: number;
  defectZones: HideDefectZone[];
  placements: PlacedNestItem[];
  unplacedPieces: string[];
  estimatedLeatherCostCny: number;
  estimatedHardwareCostCny: number;
  estimatedTotalMaterialCostCny: number;
  notes: string[];
}

export interface ProjectSnapshot {
  bagType: BagType;
  dimensions: ProductDimensions;
  materialId: string;
  edgeProcess: EdgeProcessType;
  features: EnabledFeatures;
  hardware: HardwareSpec[];
  components: ComponentItem[];
  relations: ComponentRelation[];
  patterns: PatternPiece[];
  validation: ValidationReport;
  qualitySignoff?: QualitySignoff;
}

export interface ProjectVersion {
  version: number;
  timestamp: string;
  summary: string;
  author: 'user' | 'ai';
  snapshot: ProjectSnapshot;
}

export interface ExportRecord {
  id: string;
  format: 'pdf' | 'dxf' | 'svg' | 'json' | 'csv';
  fileName: string;
  createdAt: string;
  pageFormat?: 'A4' | 'A3' | 'LARGE';
  roundTripVerified?: boolean;
  roundTripSummary?: string;
}

export interface VisionAnalysisSummary {
  detectedBagType: BagType;
  confidence: number;
  visualNotes: string;
  observedFeatures: string[];
  uncertainStructures: string[];
  clarifyingQuestion?: string;
  analyzedAt: string;
}

export interface Project {
  id: string;
  name: string;
  bagType: BagType;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  undoStack: ProjectSnapshot[];
  redoStack: ProjectSnapshot[];
  images: ProductImage[];
  visionSummary?: VisionAnalysisSummary;
  dimensions: ProductDimensions;
  materialId: string;
  edgeProcess: EdgeProcessType;
  features: EnabledFeatures;
  hardware: HardwareSpec[];
  components: ComponentItem[];
  relations: ComponentRelation[];
  patterns: PatternPiece[];
  validation: ValidationReport;
  qualitySignoff?: QualitySignoff;
  messages: AiChatMessage[];
  commandLog: Array<{
    id: string;
    timestamp: string;
    command: StructuredCadCommand;
    resultSummary: string;
  }>;
  versions: ProjectVersion[];
  exports: ExportRecord[];
}
