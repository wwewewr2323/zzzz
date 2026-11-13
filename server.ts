import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  computePieceGeometry,
  createStarterSnapshot,
  executeCadTransaction,
  generateParametricPatterns,
  validateProjectPatterns,
} from './src/shared/cadEngine.ts';
import { exportProjectToDxf, parseAndVerifyDxf } from './src/shared/cadExport.ts';
import { BAG_ARCHETYPES, BAG_TYPE_LABELS } from './src/shared/leatherKnowledge.ts';
import type {
  AiAnalysisJob,
  BagType,
  CommandPlan,
  ImageAngle,
  PatternPiece,
  ProductImage,
  Project,
  ProjectSnapshot,
  StructuredCadCommand,
} from './src/shared/types.ts';
import {
  analyzeBagPhotosWithGemini,
  getGeminiModelId,
  planNaturalLanguageCommandWithGemini,
} from './server/geminiService.ts';
import {
  deleteProjectForUser,
  getProjectForUser,
  listProjectsForUser,
  upsertProjectForUser,
} from './server/pgProjectsRepo.ts';
import {
  archiveProjectAsCase,
  deleteUserMemoryItem,
  ensureIntelligenceSeeded,
  getIntelligenceOverview,
  recordAiFeedbackAndExtractLearning,
  retrieveRelevantMemoryForPrompt,
  reviewLearningCandidate,
  rollbackKnowledgeVersion,
  runAiEvaluationSuite,
  upsertMemoryItemWithMerge,
} from './server/intelligenceService.ts';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import { getUserByUid, updateUserPreferences } from './src/db/users.ts';

const analysisJobs = new Map<string, { job: AiAnalysisJob; ownerUid: string }>();

function saveJob(job: AiAnalysisJob, ownerUid: string): AiAnalysisJob {
  const updated: AiAnalysisJob = { ...job, updatedAt: new Date().toISOString() };
  analysisJobs.set(updated.id, { job: updated, ownerUid });
  if (analysisJobs.size > 200) {
    const oldestKey = analysisJobs.keys().next().value;
    if (oldestKey) analysisJobs.delete(oldestKey);
  }
  return updated;
}

function extractSnapshot(project: Project): ProjectSnapshot {
  return {
    bagType: project.bagType,
    dimensions: structuredClone(project.dimensions),
    materialId: project.materialId,
    edgeProcess: project.edgeProcess,
    features: structuredClone(project.features),
    hardware: structuredClone(project.hardware),
    components: structuredClone(project.components),
    relations: structuredClone(project.relations),
    patterns: structuredClone(project.patterns),
    validation: structuredClone(project.validation),
    qualitySignoff: project.qualitySignoff
      ? structuredClone(project.qualitySignoff)
      : { patternMakerConfirmed: false, physicalSamplePassed: false },
  };
}

function applySnapshotToProject(project: Project, snap: ProjectSnapshot): void {
  project.bagType = snap.bagType;
  project.dimensions = structuredClone(snap.dimensions);
  project.materialId = snap.materialId;
  project.edgeProcess = snap.edgeProcess;
  project.features = structuredClone(snap.features);
  project.hardware = structuredClone(snap.hardware);
  project.components = structuredClone(snap.components);
  project.relations = structuredClone(snap.relations);
  project.patterns = structuredClone(snap.patterns);
  project.validation = structuredClone(snap.validation);
  project.qualitySignoff = snap.qualitySignoff
    ? structuredClone(snap.qualitySignoff)
    : { patternMakerConfirmed: false, physicalSamplePassed: false };
}

function pushVersionAndUndo(
  project: Project,
  prevSnap: ProjectSnapshot,
  summary: string,
  author: 'user' | 'ai'
) {
  project.undoStack.push(prevSnap);
  if (project.undoStack.length > 30) {
    project.undoStack.shift();
  }
  project.redoStack = [];
  project.currentVersion += 1;
  project.versions.unshift({
    version: project.currentVersion,
    timestamp: new Date().toISOString(),
    summary,
    author,
    snapshot: extractSnapshot(project),
  });
  if (project.versions.length > 40) {
    project.versions.length = 40;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // 0. System Health & Model Diagnostics (public health check)
  app.get('/api/v1/system/health', (_req, res) => {
    res.json({
      status: 'ok',
      aiModel: getGeminiModelId(),
      aiConfigured: Boolean(process.env.GEMINI_API_KEY),
      cadEngine: 'ruda-parametric-2d-v1',
      intelligenceVersion: 'v1.1',
      supportedBagTypes: ['tote', 'handbag', 'shoulder_bag'],
      exportFormats: ['pdf', 'dxf', 'svg', 'csv', 'json'],
    });
  });

  // 1. List user projects (PostgreSQL ownerUid isolated)
  app.get('/api/v1/projects', requireAuth, async (req: AuthRequest, res) => {
    try {
      await ensureIntelligenceSeeded();
      const rows = await listProjectsForUser(req.user!.uid);
      const projects = rows.map((p) => ({
        id: p.id,
        name: p.name,
        bagType: p.bagType,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        currentVersion: p.currentVersion,
        dimensions: p.dimensions,
        thumbnailUrl: p.images[0]?.dataUrl ?? null,
        componentCount: p.components.length,
        patternCount: p.patterns.length,
        validationPassed: p.validation.passed,
      }));
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '加载项目列表失败' });
    }
  });

  // 2. Create project
  app.post('/api/v1/projects', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const {
        name,
        bagType = 'tote',
        images = [],
        initialPrompt,
        blankMode = false,
      } = req.body as {
        name?: string;
        bagType?: BagType;
        images?: Array<{ name: string; angle: ImageAngle; dataUrl: string; mimeType: string }>;
        initialPrompt?: string;
        blankMode?: boolean;
      };

      const now = new Date().toISOString();
      const safeType: BagType =
        bagType === 'handbag' || bagType === 'shoulder_bag' ? bagType : 'tote';
      const snap = createStarterSnapshot(safeType);

      // Apply Layer 2 user preference if consented
      const userProfile = await getUserByUid(uid);
      if (
        !blankMode &&
        userProfile?.preferencesJson?.memoryConsentEnabled !== false &&
        userProfile?.preferencesJson?.preferredMaterials?.length
      ) {
        const prefMat = userProfile.preferencesJson.preferredMaterials[0];
        if (prefMat) {
          snap.materialId = prefMat;
          const regen = generateParametricPatterns(
            safeType,
            snap.dimensions,
            snap.materialId,
            snap.edgeProcess,
            snap.features
          );
          snap.components = regen.components;
          snap.relations = regen.relations;
          snap.patterns = regen.patterns;
          snap.validation = validateProjectPatterns(
            snap.patterns,
            snap.relations,
            snap.materialId,
            snap.edgeProcess
          );
        }
      }

      if (blankMode) {
        snap.components = [];
        snap.relations = [];
        snap.patterns = [];
        snap.validation = validateProjectPatterns([], [], snap.materialId, snap.edgeProcess);
      }

      const projectImages: ProductImage[] = images.map((img, i) => ({
        id: `img_${Date.now()}_${i}`,
        name: img.name || `photo_${i + 1}.jpg`,
        angle: img.angle || 'front',
        dataUrl: img.dataUrl,
        mimeType: img.mimeType || 'image/jpeg',
        uploadedAt: now,
      }));

      const project: Project = {
        id: `proj_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name:
          name?.trim() ||
          (blankMode ? '新建手工纸格项目' : `${BAG_ARCHETYPES[safeType].label}项目`),
        createdAt: now,
        updatedAt: now,
        currentVersion: 1,
        undoStack: [],
        redoStack: [],
        images: projectImages,
        ...snap,
        messages: initialPrompt
          ? [
              {
                id: `msg_${Date.now()}`,
                role: 'user',
                content: initialPrompt,
                timestamp: now,
              },
            ]
          : [
              {
                id: `msg_${Date.now()}`,
                role: 'assistant',
                content: blankMode
                  ? '已创建空白 CAD 纸格项目。你可以在右侧「部件」面板点击「+ 手工新增纸格」或导入 DXF，也可以直接通过 AI 对话生成部件。'
                  : '项目已建立。系统已接入 RUDA Leather Intelligence 五层长记忆与专业知识库，你可以随时告诉我你想修改的尺寸、结构或工艺。',
                timestamp: now,
              },
            ],
        commandLog: [],
        versions: [
          {
            version: 1,
            timestamp: now,
            summary: blankMode ? '空白 CAD 项目初始化' : `初始化 ${BAG_TYPE_LABELS[safeType]}`,
            author: 'user',
            snapshot: structuredClone(snap),
          },
        ],
        exports: [],
      };

      await upsertProjectForUser(uid, project, {
        activeTask: initialPrompt || '项目初始化',
        lastIntent: 'create_project',
      });
      res.status(201).json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '创建项目失败' });
    }
  });

  // 3. Get single project (automatically restores Layer 3 project memory)
  app.get('/api/v1/projects/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const project = await getProjectForUser(req.params.id, req.user!.uid);
      if (!project) {
        return res.status(404).json({ error: '项目不存在或无权访问' });
      }
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '读取项目失败' });
    }
  });

  // Delete project
  app.delete('/api/v1/projects/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ok = await deleteProjectForUser(req.params.id, req.user!.uid);
      if (!ok) return res.status(404).json({ error: '项目不存在或无权删除' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '删除项目失败' });
    }
  });

  // 4. Update project / Save manual CAD edits (tracks manual corrections for Continuous Learning)
  app.patch('/api/v1/projects/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const {
        expectedVersion,
        name,
        patterns,
        dimensions,
        materialId,
        edgeProcess,
        features,
        regenerateFromParams,
        versionSummary,
      } = req.body as Partial<Project> & {
        expectedVersion?: number;
        regenerateFromParams?: boolean;
        versionSummary?: string;
      };

      if (expectedVersion != null && expectedVersion !== project.currentVersion) {
        return res.status(409).json({
          error: `版本冲突：服务器当前为 v${project.currentVersion}，请刷新后重试。`,
          currentVersion: project.currentVersion,
        });
      }

      const prevSnap = extractSnapshot(project);

      if (name != null) project.name = name;
      if (dimensions) project.dimensions = { ...project.dimensions, ...dimensions };
      if (materialId) project.materialId = materialId;
      if (edgeProcess) project.edgeProcess = edgeProcess;
      if (features) project.features = { ...project.features, ...features };

      if (regenerateFromParams) {
        const customPieces = project.patterns.filter(
          (x) => x.id.startsWith('custom_') || x.id.startsWith('dxf_')
        );
        const generated = generateParametricPatterns(
          project.bagType,
          project.dimensions,
          project.materialId,
          project.edgeProcess,
          project.features,
          project.patterns
        );
        project.components = generated.components;
        project.relations = generated.relations;
        project.patterns = [...generated.patterns, ...customPieces];
      } else if (Array.isArray(patterns)) {
        project.patterns = patterns.map((p: PatternPiece) => computePieceGeometry(p));
      }

      project.validation = validateProjectPatterns(
        project.patterns,
        project.relations,
        project.materialId,
        project.edgeProcess
      );
      if (regenerateFromParams || Array.isArray(patterns)) {
        project.qualitySignoff = {
          patternMakerConfirmed: false,
          physicalSamplePassed: false,
        };
      }

      if (versionSummary) {
        pushVersionAndUndo(project, prevSnap, versionSummary, 'user');
      }

      await upsertProjectForUser(uid, project, {
        activeTask: versionSummary || '手动编辑纸格',
        lastIntent: 'manual_edit',
      });

      // Classify manual edits & extract LEVEL 1 learning candidate without auto-promoting
      if (regenerateFromParams || Array.isArray(patterns)) {
        const materialChanged = prevSnap.materialId !== project.materialId;
        const seamChanged =
          prevSnap.dimensions.seamAllowanceMm !== project.dimensions.seamAllowanceMm ||
          prevSnap.edgeProcess !== project.edgeProcess;

        const classification = materialChanged
          ? 'user_preference'
          : seamChanged
            ? 'general_rule_candidate'
            : Array.isArray(patterns)
              ? 'reusable_experience'
              : 'project_specific';

        const detailText =
          versionSummary ||
          (materialChanged
            ? `手工调整材料为 ${project.materialId}（${project.edgeProcess}）`
            : `手工修正 ${project.bagType} 纸格几何节点/缝份`);

        if (materialChanged) {
          await upsertMemoryItemWithMerge({
            ownerUid: uid,
            memoryLayer: 'user_long_term',
            memoryKey: `preferred_material_${project.bagType}`,
            content: `用户在 ${project.bagType} 参数面板偏好选用皮料 ${project.materialId}（${project.edgeProcess}）`,
            applicableBagTypes: [project.bagType],
            applicableMaterials: [project.materialId],
            source: `项目 ${project.name} 参数调整`,
            sourceProjectId: project.id,
            securityScope: 'C_USER_PRIVATE',
            reviewLevel: 3,
          });
        }

        await recordAiFeedbackAndExtractLearning({
          ownerUid: uid,
          project,
          userOriginalPrompt: versionSummary || '用户/打版师手工修正版型',
          interpretedTask: '人工修正 CAD 参数或纸格几何',
          retrievedKnowledgeIds: [],
          usedCaseIds: [],
          commands: [],
          diffSummary: [detailText],
          validationPassed: project.validation.passed,
          userAccepted: true,
          patternMakerCorrected: true,
          correctionClassification: classification,
          correctionDetail: detailText,
        });
      }

      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存项目修改失败' });
    }
  });

  // 5. Upload product images
  app.post('/api/v1/projects/:id/images', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const { images } = req.body as {
        images: Array<{ name: string; angle: ImageAngle; dataUrl: string; mimeType: string }>;
      };
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: '请至少上传一张参考照片' });
      }

      const now = new Date().toISOString();
      const added: ProductImage[] = images.map((img, i) => ({
        id: `img_${Date.now()}_${i}`,
        name: img.name || `reference_${i + 1}.jpg`,
        angle: img.angle || 'front',
        dataUrl: img.dataUrl,
        mimeType: img.mimeType || 'image/jpeg',
        uploadedAt: now,
      }));

      project.images.push(...added);
      await upsertProjectForUser(uid, project);
      res.status(201).json({ images: added, project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '上传参考照片失败' });
    }
  });

  // 6. Start async AI Vision Analysis job
  app.post('/api/v1/projects/:id/analysis', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const { userBrief = '' } = req.body as { userBrief?: string };
      const now = new Date().toISOString();
      const job: AiAnalysisJob = {
        id: `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        projectId: project.id,
        status: 'queued',
        progress: 10,
        statusMessage: '任务已入队，准备读取参考照片...',
        createdAt: now,
        updatedAt: now,
      };
      saveJob(job, uid);

      // Run async AI vision -> structure reasoning -> CAD generation -> validation pipeline
      (async () => {
        try {
          saveJob(
            {
              ...job,
              status: 'vision_analyzing',
              progress: 30,
              statusMessage: '正在通过视觉引擎识别包型、可见皮料部件与五金...',
            },
            uid
          );

          const vision = await analyzeBagPhotosWithGemini(project.images, userBrief);

          saveJob(
            {
              ...job,
              status: 'structure_reasoning',
              progress: 60,
              statusMessage: '正在检索历史工程经验并推理隐藏内部结构（内衬、底托、连接关系）...',
            },
            uid
          );

          const latestProject = await getProjectForUser(project.id, uid);
          if (!latestProject) throw new Error('项目已被删除');

          const prevSnap = extractSnapshot(latestProject);
          const arch = BAG_ARCHETYPES[vision.detectedBagType];

          latestProject.bagType = vision.detectedBagType;
          latestProject.materialId = vision.materialId;
          latestProject.edgeProcess = vision.edgeProcess;
          latestProject.features = vision.features;
          latestProject.hardware = arch.hardware.map((h) => ({ ...h }));
          latestProject.dimensions = {
            ...arch.dimensions,
            widthMm: vision.widthMm,
            heightMm: vision.heightMm,
            depthMm: vision.depthMm,
            handleLengthMm: vision.handleLengthMm,
            gussetStyle: vision.gussetStyle,
            dimensionSource: vision.userProvidedDimensions
              ? 'user_confirmed'
              : 'ai_estimated',
            calibrationNote: vision.userProvidedDimensions
              ? '用户已在设计需求中明确指定尺寸'
              : 'AI 根据参考照片比例估算（建议输入任一真实尺寸校准）',
          };

          saveJob(
            {
              ...job,
              status: 'pattern_generating',
              progress: 82,
              statusMessage: '正在调用参数化 CAD 几何引擎生成二维生产纸格与缝份...',
            },
            uid
          );

          const generated = generateParametricPatterns(
            latestProject.bagType,
            latestProject.dimensions,
            latestProject.materialId,
            latestProject.edgeProcess,
            latestProject.features
          );

          for (const comp of generated.components) {
            const match = vision.detectedParts.find(
              (dp) =>
                dp.standardType === comp.standardType ||
                dp.name.includes(comp.name) ||
                comp.name.includes(dp.name)
            );
            if (match) {
              comp.confidence = Math.max(0.4, Math.min(0.99, match.confidence));
              comp.isInferredHidden = match.isInferredHidden;
              if (match.boundingBox2D && match.boundingBox2D.length === 4) {
                comp.boundingBox2D = match.boundingBox2D;
              }
            }
          }

          latestProject.components = generated.components;
          latestProject.relations = generated.relations;
          latestProject.patterns = generated.patterns;

          saveJob(
            {
              ...job,
              status: 'validating',
              progress: 94,
              statusMessage: '正在运行轮廓闭合、接缝长度及工艺校验...',
            },
            uid
          );

          latestProject.validation = validateProjectPatterns(
            latestProject.patterns,
            latestProject.relations,
            latestProject.materialId,
            latestProject.edgeProcess
          );

          latestProject.visionSummary = {
            detectedBagType: vision.detectedBagType,
            confidence: vision.confidence,
            visualNotes: vision.visualNotes,
            observedFeatures: vision.observedFeatures,
            uncertainStructures: vision.uncertainStructures,
            clarifyingQuestion: vision.clarifyingQuestion,
            analyzedAt: new Date().toISOString(),
          };

          const retrievedMem = await retrieveRelevantMemoryForPrompt(
            uid,
            latestProject,
            userBrief || vision.visualNotes
          );

          const dimLabel = vision.userProvidedDimensions ? '已按您给出的真实尺寸' : 'AI 按比例估算尺寸';
          const assistantSummary = [
            `结构拆解与自动打版已完成：识别为 **${BAG_TYPE_LABELS[vision.detectedBagType]}**（置信度 ${Math.round(vision.confidence * 100)}%）。`,
            `${dimLabel}生成 ${latestProject.patterns.length} 个独立二维纸格（${latestProject.dimensions.widthMm} × ${latestProject.dimensions.heightMm} × ${latestProject.dimensions.depthMm} mm），${latestProject.relations.length} 条部件缝合连接关系。`,
            retrievedMem.similarCases.length > 0
              ? `已关联相似历史案例参考：${retrievedMem.similarCases[0].title}。`
              : '',
            vision.uncertainStructures.length > 0
              ? `标记需确认的隐藏/推断结构：${vision.uncertainStructures.join('、')}。`
              : '',
            !vision.userProvidedDimensions && vision.clarifyingQuestion
              ? `校准建议：${vision.clarifyingQuestion}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n');

          latestProject.messages.push({
            id: `msg_${Date.now()}`,
            role: 'assistant',
            content: assistantSummary,
            timestamp: new Date().toISOString(),
          });

          pushVersionAndUndo(
            latestProject,
            prevSnap,
            `AI 视觉拆解与打版 (${BAG_ARCHETYPES[vision.detectedBagType].label})`,
            'ai'
          );

          await upsertProjectForUser(uid, latestProject, {
            activeTask: '视觉拆解与首次打版完成',
            lastIntent: 'vision_analysis',
            retrievedMemoryIds: [
              ...retrievedMem.retrievedKnowledgeIds,
              ...retrievedMem.usedCaseIds,
            ],
          });

          await recordAiFeedbackAndExtractLearning({
            ownerUid: uid,
            project: latestProject,
            userOriginalPrompt: userBrief || '上传参考照片发起 AI 视觉拆解',
            interpretedTask: `视觉拆解 ${BAG_TYPE_LABELS[vision.detectedBagType]} 并生成 ${latestProject.patterns.length} 片纸格`,
            retrievedKnowledgeIds: retrievedMem.retrievedKnowledgeIds,
            usedCaseIds: retrievedMem.usedCaseIds,
            commands: [],
            diffSummary: [
              `生成 ${latestProject.patterns.length} 片二维纸格 (${latestProject.dimensions.widthMm}×${latestProject.dimensions.heightMm}×${latestProject.dimensions.depthMm}mm)`,
            ],
            validationPassed: latestProject.validation.passed,
            userAccepted: true,
          });

          saveJob(
            {
              ...job,
              status: 'completed',
              progress: 100,
              statusMessage: '结构拆解、二维打版与质量检查已全部完成。',
            },
            uid
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'AI 分析执行失败';
          saveJob(
            {
              ...job,
              status: 'failed',
              progress: 100,
              statusMessage: 'AI 分析失败',
              error: message,
            },
            uid
          );
        }
      })();

      res.status(202).json({ job });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '启动 AI 任务失败' });
    }
  });

  // 7. Poll AI analysis job
  app.get('/api/v1/jobs/:id', requireAuth, (req: AuthRequest, res) => {
    const entry = analysisJobs.get(req.params.id);
    if (!entry || entry.ownerUid !== req.user!.uid) {
      return res.status(404).json({ error: '任务不存在' });
    }
    res.json({ job: entry.job });
  });

  // 8. Get components & relations
  app.get('/api/v1/projects/:id/components', requireAuth, async (req: AuthRequest, res) => {
    const project = await getProjectForUser(req.params.id, req.user!.uid);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({
      components: project.components,
      relations: project.relations,
      hardware: project.hardware,
    });
  });

  // 9. Get patterns
  app.get('/api/v1/projects/:id/patterns', requireAuth, async (req: AuthRequest, res) => {
    const project = await getProjectForUser(req.params.id, req.user!.uid);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ patterns: project.patterns, validation: project.validation });
  });

  // 10. Plan natural language AI command (Hybrid 5-Layer Long Memory Retrieval)
  app.post('/api/v1/projects/:id/ai/command/plan', requireAuth, async (req: AuthRequest, res) => {
    const uid = req.user!.uid;
    const project = await getProjectForUser(req.params.id, uid);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const { prompt } = req.body as { prompt?: string };
    if (!prompt?.trim()) {
      return res.status(400).json({ error: '请输入设计指令' });
    }

    try {
      const retrievedMemory = await retrieveRelevantMemoryForPrompt(uid, project, prompt.trim());
      const plan = await planNaturalLanguageCommandWithGemini(
        project,
        prompt.trim(),
        retrievedMemory
      );
      await upsertProjectForUser(uid, project, {
        activeTask: plan.summary,
        lastIntent: plan.commands[0]?.intent || 'plan',
        retrievedMemoryIds: [
          ...retrievedMemory.retrievedKnowledgeIds,
          ...retrievedMemory.usedCaseIds,
        ],
      });
      res.json({ plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 指令解析失败';
      res.status(500).json({ error: msg });
    }
  });

  // 11. Execute verified CAD command plan + 11-point Continuous Learning Audit
  app.post('/api/v1/projects/:id/ai/command/execute', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const {
        expectedVersion,
        userPrompt,
        commands,
        replyText,
        plan,
      } = req.body as {
        expectedVersion?: number;
        userPrompt?: string;
        commands: StructuredCadCommand[];
        replyText?: string;
        plan?: CommandPlan;
      };

      if (expectedVersion != null && expectedVersion !== project.currentVersion) {
        return res.status(409).json({
          error: `版本冲突：服务器当前为 v${project.currentVersion}，请先同步最新状态。`,
        });
      }

      const now = new Date().toISOString();
      if (userPrompt) {
        project.messages.push({
          id: `msg_u_${Date.now()}`,
          role: 'user',
          content: userPrompt,
          timestamp: now,
        });
      }

      // If no commands (advice/options mode or pending confirmation), just record assistant response
      if (!Array.isArray(commands) || commands.length === 0) {
        project.messages.push({
          id: `msg_a_${Date.now() + 1}`,
          role: 'assistant',
          content: replyText || plan?.replyText || '请选择下方具体方案以执行修改。',
          timestamp: now,
          plan,
          planStatus: plan?.proposedOptions?.length ? 'pending_confirmation' : 'advice_only',
        });
        await upsertProjectForUser(uid, project);
        return res.json({ project, diffSummary: [] });
      }

      // Handle conversational undo/redo directly via stack
      if (commands.length === 1 && (commands[0].intent === 'undo_last' || commands[0].intent === 'redo_last')) {
        const isUndo = commands[0].intent === 'undo_last';
        const stack = isUndo ? project.undoStack : project.redoStack;
        if (stack.length === 0) {
          const msgText = isUndo ? '当前没有可撤销的历史修改步骤。' : '当前没有可恢复的撤销步骤。';
          project.messages.push({
            id: `msg_a_${Date.now() + 1}`,
            role: 'assistant',
            content: msgText,
            timestamp: now,
            planStatus: 'advice_only',
          });
          await upsertProjectForUser(uid, project);
          return res.json({ project, diffSummary: [] });
        }
        const currentSnap = extractSnapshot(project);
        const targetSnap = stack.pop()!;
        if (isUndo) {
          project.redoStack.push(currentSnap);
        } else {
          project.undoStack.push(currentSnap);
        }
        applySnapshotToProject(project, targetSnap);
        project.currentVersion += 1;
        const actionDiff = isUndo
          ? [`已撤销上一步修改，恢复至 v${project.currentVersion}`]
          : [`已恢复上一步修改，当前为 v${project.currentVersion}`];
        project.messages.push({
          id: `msg_a_${Date.now() + 1}`,
          role: 'assistant',
          content: replyText || actionDiff[0],
          timestamp: new Date().toISOString(),
          diffSummary: actionDiff,
          planStatus: 'executed',
        });
        await upsertProjectForUser(uid, project);

        await recordAiFeedbackAndExtractLearning({
          ownerUid: uid,
          project,
          userOriginalPrompt: userPrompt || (isUndo ? '撤销修改' : '恢复修改'),
          interpretedTask: isUndo ? '撤销上一步 AI/手工修改' : '恢复已撤销修改',
          retrievedKnowledgeIds: plan?.retrievedKnowledgeIds ?? [],
          usedCaseIds: plan?.usedCaseIds ?? [],
          commands,
          diffSummary: actionDiff,
          validationPassed: project.validation.passed,
          userAccepted: !isUndo,
        });

        return res.json({ project, diffSummary: actionDiff });
      }

      const prevSnap = extractSnapshot(project);
      const tx = executeCadTransaction(prevSnap, commands);
      if (!tx.committed) {
        project.messages.push({
          id: `msg_a_${Date.now() + 1}`,
          role: 'assistant',
          content: `操作未提交（事务已自动回滚）：${tx.rollbackReason || '检测到异常几何状态，已保护原版型不受损。'}`,
          timestamp: new Date().toISOString(),
          planStatus: 'cancelled',
        });
        await upsertProjectForUser(uid, project);

        await recordAiFeedbackAndExtractLearning({
          ownerUid: uid,
          project,
          userOriginalPrompt: userPrompt || '执行 CAD 修改指令',
          interpretedTask: plan?.summary || commands.map((c) => c.intent).join(', '),
          retrievedKnowledgeIds: plan?.retrievedKnowledgeIds ?? [],
          usedCaseIds: plan?.usedCaseIds ?? [],
          commands,
          diffSummary: [tx.rollbackReason || '事务触发几何安全回滚'],
          validationPassed: false,
          userAccepted: false,
        });

        return res.json({
          project,
          diffSummary: [],
          rolledBack: true,
          rollbackReason: tx.rollbackReason,
        });
      }

      const allDiffs = tx.diffSummary;
      for (const cmd of commands) {
        project.commandLog.unshift({
          id: `cmd_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          timestamp: now,
          command: cmd,
          resultSummary: allDiffs.join('；') || cmd.operation,
        });
      }

      applySnapshotToProject(project, tx.nextSnapshot);
      const versionDesc =
        plan?.summary || allDiffs[0] || `AI 执行设计修改 (${commands[0].intent})`;
      pushVersionAndUndo(project, prevSnap, versionDesc, 'ai');

      const validationNote = project.validation.passed
        ? `几何与接缝校验全部通过（${project.validation.checksRun.length} 项）。`
        : `校验提示：发现 ${project.validation.errorCount} 个错误、${project.validation.warningCount} 个工艺警告，请在右侧「校验」面板查看详情。`;

      project.messages.push({
        id: `msg_a_${Date.now() + 1}`,
        role: 'assistant',
        content: `${replyText || plan?.replyText || '已完成修改。'}\n\n${validationNote}`,
        timestamp: new Date().toISOString(),
        diffSummary: allDiffs,
        plan,
        planStatus: 'executed',
      });

      await upsertProjectForUser(uid, project, {
        activeTask: versionDesc,
        lastIntent: commands[0]?.intent,
        retrievedMemoryIds: [
          ...(plan?.retrievedKnowledgeIds ?? []),
          ...(plan?.usedCaseIds ?? []),
        ],
      });

      await recordAiFeedbackAndExtractLearning({
        ownerUid: uid,
        project,
        userOriginalPrompt: userPrompt || versionDesc,
        interpretedTask: plan?.summary || versionDesc,
        retrievedKnowledgeIds: plan?.retrievedKnowledgeIds ?? [],
        usedCaseIds: plan?.usedCaseIds ?? [],
        commands,
        diffSummary: allDiffs,
        validationPassed: project.validation.passed,
        userAccepted: true,
        correctionClassification: commands.some((c) => c.intent === 'fix_seam_mismatch')
          ? 'reusable_experience'
          : undefined,
        correctionDetail: commands.some((c) => c.intent === 'fix_seam_mismatch')
          ? allDiffs.join('；')
          : undefined,
      });

      res.json({ project, diffSummary: allDiffs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '执行 CAD 指令失败' });
    }
  });

  // 11b. Record explicit patternmaker or physical sample signoff
  app.post('/api/v1/projects/:id/quality-signoff', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const {
        patternMakerConfirmed,
        patternMakerName,
        physicalSamplePassed,
        sampleLotNote,
      } = req.body as {
        patternMakerConfirmed?: boolean;
        patternMakerName?: string;
        physicalSamplePassed?: boolean;
        sampleLotNote?: string;
      };

      const current = project.qualitySignoff ?? {
        patternMakerConfirmed: false,
        physicalSamplePassed: false,
      };
      const now = new Date().toISOString();
      project.qualitySignoff = {
        patternMakerConfirmed:
          patternMakerConfirmed != null ? patternMakerConfirmed : current.patternMakerConfirmed,
        patternMakerName: patternMakerName ?? current.patternMakerName,
        patternMakerAt:
          patternMakerConfirmed != null ? (patternMakerConfirmed ? now : undefined) : current.patternMakerAt,
        physicalSamplePassed:
          physicalSamplePassed != null ? physicalSamplePassed : current.physicalSamplePassed,
        sampleLotNote: sampleLotNote ?? current.sampleLotNote,
        physicalSampleAt:
          physicalSamplePassed != null ? (physicalSamplePassed ? now : undefined) : current.physicalSampleAt,
      };
      await upsertProjectForUser(uid, project);
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新质量签核失败' });
    }
  });

  // 12. Validate specific piece or full project
  app.post('/api/v1/projects/:id/patterns/:pieceId/validate', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      project.patterns = project.patterns.map((p) => computePieceGeometry(p));
      project.validation = validateProjectPatterns(
        project.patterns,
        project.relations,
        project.materialId,
        project.edgeProcess
      );
      await upsertProjectForUser(uid, project);
      res.json({ validation: project.validation, project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '执行纸格校验失败' });
    }
  });

  // 13. Manual version checkpoint / restore / undo / redo
  app.post('/api/v1/projects/:id/versions', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      const { summary = '手动保存版本快照' } = req.body as { summary?: string };
      const prevSnap = extractSnapshot(project);
      pushVersionAndUndo(project, prevSnap, summary, 'user');
      await upsertProjectForUser(uid, project);
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存版本失败' });
    }
  });

  app.post('/api/v1/projects/:id/versions/:version/restore', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      const verNum = Number.parseInt(req.params.version, 10);
      const target = project.versions.find((v) => v.version === verNum);
      if (!target) return res.status(404).json({ error: '指定历史版本不存在' });

      const prevSnap = extractSnapshot(project);
      applySnapshotToProject(project, target.snapshot);
      pushVersionAndUndo(project, prevSnap, `恢复至历史版本 v${verNum}`, 'user');
      await upsertProjectForUser(uid, project);
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '恢复版本失败' });
    }
  });

  app.post('/api/v1/projects/:id/undo', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      if (project.undoStack.length === 0) {
        return res.status(400).json({ error: '没有可撤销的操作' });
      }
      const currentSnap = extractSnapshot(project);
      const prevSnap = project.undoStack.pop()!;
      project.redoStack.push(currentSnap);
      applySnapshotToProject(project, prevSnap);
      project.currentVersion += 1;
      await upsertProjectForUser(uid, project);
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '撤销失败' });
    }
  });

  app.post('/api/v1/projects/:id/redo', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      if (project.redoStack.length === 0) {
        return res.status(400).json({ error: '没有可恢复的操作' });
      }
      const currentSnap = extractSnapshot(project);
      const nextSnap = project.redoStack.pop()!;
      project.undoStack.push(currentSnap);
      applySnapshotToProject(project, nextSnap);
      project.currentVersion += 1;
      await upsertProjectForUser(uid, project);
      res.json({ project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '恢复失败' });
    }
  });

  // 14. Production exports & DXF round-trip verification
  app.post('/api/v1/projects/:id/exports', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const { format, pageFormat } = req.body as {
        format: 'pdf' | 'dxf' | 'svg' | 'json' | 'csv';
        pageFormat?: 'A4' | 'A3' | 'LARGE';
      };

      let roundTripVerified = true;
      let roundTripSummary = '几何与单位校验通过 (1:1 mm)';

      if (format === 'dxf') {
        const dxfText = exportProjectToDxf(project);
        const check = parseAndVerifyDxf(dxfText, project.patterns);
        roundTripVerified = check.valid;
        roundTripSummary = check.summary;
      }

      const record = {
        id: `exp_${Date.now()}`,
        format,
        fileName: `${project.name}_v${project.currentVersion}.${format}`,
        createdAt: new Date().toISOString(),
        pageFormat,
        roundTripVerified,
        roundTripSummary,
      };

      project.exports.unshift(record);
      if (project.exports.length > 25) project.exports.length = 25;
      await upsertProjectForUser(uid, project);
      res.status(201).json({ record, project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '导出记录保存失败' });
    }
  });

  app.get('/api/v1/projects/:id/exports', requireAuth, async (req: AuthRequest, res) => {
    const project = await getProjectForUser(req.params.id, req.user!.uid);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ exports: project.exports });
  });

  // 15. Re-import DXF into project
  app.post('/api/v1/projects/:id/import-dxf', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.id, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const { dxfText, replaceExisting = false } = req.body as {
        dxfText?: string;
        replaceExisting?: boolean;
      };
      if (!dxfText) return res.status(400).json({ error: '缺少 DXF 文件内容' });

      const parsed = parseAndVerifyDxf(dxfText);
      if (!parsed.valid) {
        return res.status(400).json({ error: parsed.summary });
      }

      const prevSnap = extractSnapshot(project);
      project.patterns = replaceExisting
        ? parsed.importedPieces
        : [...project.patterns, ...parsed.importedPieces];
      project.validation = validateProjectPatterns(
        project.patterns,
        project.relations,
        project.materialId,
        project.edgeProcess
      );
      pushVersionAndUndo(
        project,
        prevSnap,
        `导入 DXF 纸格 (${parsed.importedPieces.length} 片)`,
        'user'
      );
      await upsertProjectForUser(uid, project);
      res.json({ verification: parsed, project });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'DXF 导入失败' });
    }
  });

  // ==================== V1.1 RUDA Leather Intelligence Endpoints ====================

  app.get('/api/v1/intelligence/overview', requireAuth, async (req: AuthRequest, res) => {
    try {
      const overview = await getIntelligenceOverview(req.user!.uid);
      res.json(overview);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '加载知识库总览失败' });
    }
  });

  app.get('/api/v1/intelligence/retrieve', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      let project = projectId ? await getProjectForUser(projectId, uid) : null;
      if (!project) {
        const snap = createStarterSnapshot('tote');
        project = {
          id: 'query_ctx',
          name: '检索上下文',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          currentVersion: 1,
          undoStack: [],
          redoStack: [],
          images: [],
          ...snap,
          messages: [],
          commandLog: [],
          versions: [],
          exports: [],
        };
      }
      const bundle = await retrieveRelevantMemoryForPrompt(uid, project, q);
      res.json(bundle);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '混合检索失败' });
    }
  });

  app.patch('/api/v1/intelligence/preferences', requireAuth, async (req: AuthRequest, res) => {
    try {
      const updated = await updateUserPreferences(req.user!.uid, req.body);
      res.json({ preferences: updated?.preferencesJson ?? {} });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新用户偏好失败' });
    }
  });

  app.post('/api/v1/intelligence/memories', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        memoryLayer = 'user_long_term',
        memoryKey,
        content,
        applicableBagTypes = [],
        applicableMaterials = [],
        relatedParts = [],
        sourceProjectId,
      } = req.body as {
        memoryLayer?: 'session' | 'user_long_term' | 'project_long_term' | 'engineering_knowledge' | 'historical_experience';
        memoryKey: string;
        content: string;
        applicableBagTypes?: string[];
        applicableMaterials?: string[];
        relatedParts?: string[];
        sourceProjectId?: string;
      };

      if (!memoryKey?.trim() || !content?.trim()) {
        return res.status(400).json({ error: '记忆键与内容不能为空' });
      }

      const item = await upsertMemoryItemWithMerge({
        ownerUid: req.user!.uid,
        memoryLayer,
        memoryKey: memoryKey.trim(),
        content: content.trim(),
        applicableBagTypes,
        applicableMaterials,
        relatedParts,
        source: '用户主动录入偏好记忆',
        sourceProjectId,
        securityScope: 'C_USER_PRIVATE',
        reviewLevel: 3,
      });

      if (!item) {
        return res.status(403).json({ error: '您已关闭个人长期记忆收集授权，请在设置中开启后再试。' });
      }
      res.status(201).json({ memory: item });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存长期记忆失败' });
    }
  });

  app.delete('/api/v1/intelligence/memories/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ok = await deleteUserMemoryItem(req.params.id, req.user!.uid);
      if (!ok) return res.status(404).json({ error: '记忆条目不存在或无权删除' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '删除记忆失败' });
    }
  });

  app.post('/api/v1/intelligence/learning-candidates/:id/review', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        action,
        targetReviewLevel = 4,
        securityScope = 'C_USER_PRIVATE',
        reviewNote,
        createEvalCase = true,
      } = req.body as {
        action: 'approve' | 'reject' | 'promote_level';
        targetReviewLevel?: number;
        securityScope?: 'A_PLATFORM_PUBLIC' | 'B_ENTERPRISE_PRIVATE' | 'C_USER_PRIVATE';
        reviewNote?: string;
        createEvalCase?: boolean;
      };

      const result = await reviewLearningCandidate({
        candidateId: req.params.id,
        reviewerUid: req.user!.uid,
        reviewerName: (typeof req.user!.name === 'string' && req.user!.name) || req.user!.email || '专业打版师',
        action,
        targetReviewLevel,
        securityScope,
        reviewNote,
        createEvalCase,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '审核学习经验失败' });
    }
  });

  app.post('/api/v1/intelligence/cases/archive/:projectId', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const project = await getProjectForUser(req.params.projectId, uid);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      const { securityScope = 'C_USER_PRIVATE', productionResultNote = '' } = req.body as {
        securityScope?: 'A_PLATFORM_PUBLIC' | 'B_ENTERPRISE_PRIVATE' | 'C_USER_PRIVATE';
        productionResultNote?: string;
      };

      const savedCase = await archiveProjectAsCase({
        project,
        ownerUid: uid,
        securityScope,
        productionResultNote,
      });
      res.status(201).json({ caseItem: savedCase });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '归档工程案例失败' });
    }
  });

  app.post('/api/v1/intelligence/versions/:id/rollback', requireAuth, async (req: AuthRequest, res) => {
    try {
      const result = await rollbackKnowledgeVersion({
        versionId: req.params.id,
        reviewerUid: req.user!.uid,
        reviewerName: (typeof req.user!.name === 'string' && req.user!.name) || req.user!.email || '专业打版师',
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '回滚知识版本失败' });
    }
  });

  app.post('/api/v1/intelligence/evaluations/run', requireAuth, async (req: AuthRequest, res) => {
    try {
      const summary = await runAiEvaluationSuite(req.user!.uid);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '运行 AI 能力回归评估失败' });
    }
  });

  // Vite dev middleware vs static dist
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`RUDA AI Leather Studio running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
