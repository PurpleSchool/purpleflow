// Фасад ядра: публичный API (CoreApi) поверх движка, стадий и сервисов.
// Логики здесь нет — только сборка ядра и разводка команд по модулям.
import path from 'node:path';
import { checkCommand, detectProjectCommands, findEnvFiles } from './detect.js';
import * as engine from './engine.js';
import { decide } from './gates.js';
import { detectTools, which } from './env.js';
import { Git } from './git.js';
import { Kernel } from './kernel.js';
import type { CoreOptions, Listener } from './runtime.js';
import { getAttachment } from './services/attachments.js';
import * as chat from './services/chat.js';
import { testConnection } from './services/connection.js';
import { control } from './services/control.js';
import { cleanStorage, getStorage } from './services/disk.js';
import { askManager, getManagerChat, resolveManagerAction } from './services/manager.js';
import * as pr from './services/pr.js';
import { getPreview, startPreview, stopPreview } from './services/preview.js';
import * as projects from './services/projects.js';
import { getChangeDocs, getChangedFiles, getDiff } from './services/runs.js';
import { answer } from './stages/plan.js';
import { getVisualShot } from './stages/visual.js';
import type {
  ChangeDocs,
  ChatFile,
  CommandIssue,
  CoreApi,
  CoreCommand,
  ManagerMessage,
  ProjectCommands,
  ProjectConfig,
  ProjectKnowledge,
  StorageItem,
} from './types.js';

export class Orchestrator implements CoreApi {
  readonly kernel: Kernel;

  constructor(opts: CoreOptions) {
    const k = new Kernel(opts);
    k.engine = { drive: (run) => engine.drive(k, run), halt: (id) => engine.halt(k, id) };
    this.kernel = k;
  }

  on(fn: Listener): () => void {
    return this.kernel.on(fn);
  }

  /** После перезапуска приложения: оборванные прогоны встают в очередь и продолжаются сами. */
  recover(): Promise<void> {
    return engine.recover(this.kernel);
  }

  /** Настройки поменялись (например, лимит одновременных прогонов) — может, кого-то пора запустить из очереди. */
  settingsChanged() {
    void engine.pump(this.kernel);
  }

  // ——— Команды прогона ———

  async dispatch(cmd: CoreCommand): Promise<{ runId: string }> {
    const k = this.kernel;
    if (cmd.type === 'run.start') return { runId: await engine.start(k, cmd.input) };
    switch (cmd.type) {
      case 'run.resume':
        await engine.resume(k, cmd.runId);
        break;
      case 'gate.approve':
        await decide(k, cmd.runId, 'approve', cmd.comment);
        break;
      case 'gate.reject':
        await decide(k, cmd.runId, 'reject', cmd.comment, cmd.lineComments);
        break;
      case 'gate.cancel':
        await decide(k, cmd.runId, 'cancel');
        break;
      case 'gate.accept':
        await decide(k, cmd.runId, 'accept');
        break;
      case 'gate.fix':
        await decide(k, cmd.runId, 'fix', cmd.comment, cmd.lineComments);
        break;
      case 'gate.answer':
        await answer(k, cmd.runId, cmd.answers);
        break;
      case 'run.stop':
        await engine.stop(k, cmd.runId);
        break;
      case 'run.control':
        await control(k, cmd.runId, cmd.action);
        break;
      case 'run.skipChecks':
        await engine.skipChecks(k, cmd.runId);
        break;
      case 'run.rerunVisual':
        await engine.rerunVisual(k, cmd.runId);
        break;
      case 'run.merge':
        await pr.merge(k, cmd.runId, cmd.target);
        break;
      case 'run.pr':
        await pr.openPr(k, cmd.runId, cmd.base);
        break;
      case 'run.prMerge':
        await pr.mergePrOf(k, cmd.runId);
        break;
      case 'run.prFollowup':
        await pr.prFollowup(k, cmd.runId, cmd.items, cmd.note);
        break;
      case 'run.updateBranch':
        await pr.updateBranch(k, cmd.runId);
        break;
      case 'run.delete':
        await engine.deleteRun(k, cmd.runId, cmd.deleteBranch);
        break;
    }
    return { runId: cmd.runId };
  }

  // ——— Прогоны ———

  async listRuns() {
    return this.kernel.store.list();
  }
  async getRun(id: string) {
    return this.kernel.store.load(id);
  }
  async getLog(id: string) {
    return this.kernel.store.readLog(id);
  }
  async isDriving(id: string) {
    return this.kernel.driving.has(id);
  }
  getDiff(id: string) {
    return getDiff(this.kernel, id);
  }
  getChangedFiles(id: string) {
    return getChangedFiles(this.kernel, id);
  }
  getChangeDocs(id: string): Promise<ChangeDocs> {
    return getChangeDocs(this.kernel, id);
  }
  async getAttachment(id: string, index: number) {
    return getAttachment(this.kernel, id, index);
  }
  async getVisualShot(id: string, file: string) {
    return getVisualShot(this.kernel, id, file);
  }
  nextPartDraft(id: string) {
    return projects.nextPartDraft(this.kernel, id);
  }

  // ——— Ручная проверка ———

  startPreview(id: string) {
    return startPreview(this.kernel, id);
  }
  stopPreview(id: string) {
    return stopPreview(this.kernel, id);
  }
  async getPreview(id: string) {
    return getPreview(this.kernel, id);
  }

  // ——— Ветки и Pull Request ———

  listBranches(id: string) {
    return pr.listBranches(this.kernel, id);
  }
  prReady(id: string) {
    return pr.prReady(this.kernel, id);
  }
  getPrStatus(id: string) {
    return pr.getPrStatus(this.kernel, id);
  }
  getPrDetails(id: string) {
    return pr.getPrDetails(this.kernel, id);
  }

  // ——— Менеджер прогона ———

  async getManagerChat(id: string): Promise<{ messages: ManagerMessage[]; thinking: boolean }> {
    return { messages: getManagerChat(this.kernel, id), thinking: this.kernel.managerBusy.has(id) };
  }
  askManager(id: string, text: string) {
    return askManager(this.kernel, id, text);
  }
  resolveManagerAction(id: string, messageId: string, apply: boolean) {
    return resolveManagerAction(this.kernel, id, messageId, apply);
  }

  // ——— Инструменты и подключение ———

  detectTools() {
    return detectTools(this.kernel.opts.env, this.kernel.opts.getSettings().toolPaths);
  }
  testConnection() {
    return testConnection(this.kernel);
  }

  // ——— Проекты ———

  async detectProject(dir: string): Promise<ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string }> {
    const { env, getSettings } = this.kernel.opts;
    const gitBin = getSettings().toolPaths.git || which('git', env) || 'git';
    const isRepo = await new Git(gitBin, env).isRepo(dir).catch(() => false);
    return { ...detectProjectCommands(dir), envFiles: findEnvFiles(dir), isRepo, name: path.basename(dir) };
  }
  async checkCommands(dir: string, cmds: Record<string, string>): Promise<Record<string, CommandIssue[]>> {
    return Object.fromEntries(Object.entries(cmds).map(([key, cmd]) => [key, cmd.trim() ? checkCommand(dir, cmd) : []]));
  }
  detectCommandsAI(dir: string) {
    return projects.detectCommandsAI(this.kernel, dir);
  }
  suggestMode(task: string) {
    return projects.suggestMode(this.kernel, task);
  }
  async listProjects() {
    return projects.listProjects(this.kernel);
  }
  projectOverview(dir: string) {
    return projects.projectOverview(this.kernel, dir);
  }
  async projectStats(dir: string) {
    return projects.projectStats(this.kernel, dir);
  }
  projectBranches(dir: string, fetch?: boolean) {
    return projects.projectBranches(this.kernel, dir, fetch);
  }
  async forgetProject(dir: string) {
    projects.forgetProject(this.kernel, dir);
  }
  async getProjectConfig(dir: string) {
    return projects.getProjectConfig(this.kernel, dir);
  }
  async saveProjectConfig(dir: string, cfg: Omit<ProjectConfig, 'updatedAt'>) {
    return projects.saveProjectConfig(this.kernel, dir, cfg);
  }
  async getKnowledge(dir: string) {
    return projects.getKnowledge(this.kernel, dir);
  }
  async saveKnowledge(dir: string, k: ProjectKnowledge) {
    return projects.saveKnowledge(this.kernel, dir, k);
  }
  refreshProfile(dir: string) {
    return projects.refreshProfile(this.kernel, dir);
  }
  cleanWorkingCopy(dir: string, how: 'stash' | 'discard') {
    return projects.cleanWorkingCopy(this.kernel, dir, how);
  }
  checkEnvironment(dir: string) {
    return projects.checkEnvironment(this.kernel, dir);
  }

  // ——— Место на диске ———

  getStorage() {
    return getStorage(this.kernel);
  }
  cleanStorage(id: StorageItem['id']) {
    return cleanStorage(this.kernel, id);
  }

  // ——— Чаты ———

  async listChats() {
    return chat.listChats(this.kernel);
  }
  async getChat(id: string) {
    return chat.getChat(this.kernel, id);
  }
  createChat(o: Parameters<typeof chat.createChat>[1]) {
    return chat.createChat(this.kernel, o);
  }
  async updateChat(id: string, patch: Partial<Pick<ChatFile, 'title' | 'agent' | 'model' | 'edits'>>) {
    return chat.updateChat(this.kernel, id, patch);
  }
  deleteChat(id: string) {
    return chat.deleteChat(this.kernel, id);
  }
  /** Ход идёт в фоне: ответ приходит событиями chat.updated. */
  async sendChat(id: string, text: string, files?: { name: string; data: Uint8Array }[]): Promise<void> {
    const turn = chat.sendChat(this.kernel, id, text, files);
    // Ошибки до начала хода (пустое сообщение) — сразу вызывающему; дальше всё в сообщении ответа.
    await Promise.race([turn, new Promise((r) => setTimeout(r, 50))]);
    turn.catch(() => {});
  }
  stopChat(id: string) {
    return chat.stopChat(this.kernel, id);
  }
  async unqueueChat(id: string, messageId: string) {
    return chat.unqueueChat(this.kernel, id, messageId);
  }
  chatToTask(id: string) {
    return chat.chatToTask(this.kernel, id);
  }
  getChatDiff(id: string) {
    return chat.chatDiff(this.kernel, id);
  }
  getChatChangedFiles(id: string) {
    return chat.chatChangedFiles(this.kernel, id);
  }
}
