/**
 * M3U8 下载器核心逻辑
 * 基于 M3U8Download 项目改造为 TypeScript 版本
 */

import { AESDecryptor } from './aes-decryptor';
// @ts-ignore - mux.js 没有类型定义
import * as muxjs from 'mux.js';

export interface M3U8DownloadTask {
  id: string;
  url: string;
  title: string;
  type: 'TS' | 'MP4';
  status: 'ready' | 'downloading' | 'pause' | 'done' | 'error';
  finishList: Array<{ title: string; status: '' | 'is-downloading' | 'is-success' | 'is-error' }>;
  tsUrlList: string[];
  requests: XMLHttpRequest[];
  mediaFileList: ArrayBuffer[];
  downloadIndex: number;
  downloading: boolean;
  durationSecond: number;
  beginTime: Date;
  errorNum: number;
  finishNum: number;
  retryNum: number;
  retryCountdown: number;
  rangeDownload: {
    isShowRange: boolean;
    startSegment: number;
    endSegment: number;
    targetSegment: number;
  };
  aesConf: {
    method: string;
    uri: string;
    iv: Uint8Array | null;
    key: ArrayBuffer | null;
    decryption: AESDecryptor | null;
  };
}

export interface M3U8DownloaderOptions {
  onProgress?: (task: M3U8DownloadTask) => void;
  onComplete?: (task: M3U8DownloadTask) => void;
  onError?: (task: M3U8DownloadTask, error: string) => void;
}

export class M3U8Downloader {
  private tasks: Map<string, M3U8DownloadTask> = new Map();
  private currentTask: M3U8DownloadTask | null = null;
  private options: M3U8DownloaderOptions;

  constructor(options: M3U8DownloaderOptions = {}) {
    this.options = options;
  }

  /**
   * 创建下载任务
   */
  async createTask(url: string, title: string, type: 'TS' | 'MP4' = 'TS'): Promise<string> {
    const taskId = 't_' + Date.now() + Math.random().toString(36).substr(2, 9);

    try {
      // 获取 m3u8 文件内容
      const m3u8Content = await this.fetchM3U8(url);

      if (!m3u8Content.startsWith('#EXTM3U')) {
        throw new Error('无效的 m3u8 链接');
      }

      // 检查是否是主播放列表
      if (this.isMasterPlaylist(m3u8Content)) {
        const streams = this.parseStreamInfo(m3u8Content, url);
        if (streams.length > 0) {
          // 自动选择最高清晰度
          url = streams[0].url;
          const subM3u8Content = await this.fetchM3U8(url);
          return this.processM3U8Content(taskId, url, title, type, subM3u8Content);
        }
      }

      return this.processM3U8Content(taskId, url, title, type, m3u8Content);
    } catch (error) {
      throw new Error(`创建任务失败: ${error}`);
    }
  }

  /**
   * 处理 M3U8 内容
   */
  private processM3U8Content(
    taskId: string,
    url: string,
    title: string,
    type: 'TS' | 'MP4',
    m3u8Content: string
  ): string {
    const task: M3U8DownloadTask = {
      id: taskId,
      url,
      title,
      type,
      status: 'ready',
      finishList: [],
      tsUrlList: [],
      requests: [],
      mediaFileList: [],
      downloadIndex: 0,
      downloading: false,
      durationSecond: 0,
      beginTime: new Date(),
      errorNum: 0,
      finishNum: 0,
      retryNum: 3,
      retryCountdown: 0,
      rangeDownload: {
        isShowRange: false,
        startSegment: 1,
        endSegment: 0,
        targetSegment: 0,
      },
      aesConf: {
        method: '',
        uri: '',
        iv: null,
        key: null,
        decryption: null,
      },
    };

    // 解析 TS 片段
    const lines = m3u8Content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split('#EXTINF:')[1]);
        task.durationSecond += duration;
      } else if (line.startsWith('#EXT-X-KEY')) {
        const keyMatch = line.match(/METHOD=([^,]+)(?:,URI="([^"]+)")?(?:,IV=([^,]+))?/);
        if (keyMatch) {
          task.aesConf.method = keyMatch[1];
          task.aesConf.uri = keyMatch[2] ? this.applyURL(keyMatch[2], url) : '';
          task.aesConf.iv = keyMatch[3] ? this.parseIV(keyMatch[3]) : null;
        }
      } else if (line && !line.startsWith('#')) {
        task.tsUrlList.push(this.applyURL(line, url));
        task.finishList.push({ title: line, status: '' });
      }
    }

    task.rangeDownload.endSegment = task.tsUrlList.length;
    task.rangeDownload.targetSegment = task.tsUrlList.length;

    this.tasks.set(taskId, task);
    return taskId;
  }

  /**
   * 开始下载任务
   */
  async startTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }

    if (task.status === 'downloading') {
      return;
    }

    // 如果需要 AES 解密，先获取密钥
    if (task.aesConf.method && task.aesConf.method !== 'NONE' && !task.aesConf.key) {
      await this.getAESKey(task);
    }

    task.status = 'downloading';
    this.currentTask = task;
    this.downloadTS(task);
  }

  /**
   * 暂停任务
   */
  pauseTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'pause';
    this.abortRequests(task);
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.abortRequests(task);
    this.tasks.delete(taskId);

    if (this.currentTask?.id === taskId) {
      this.currentTask = null;
    }
  }

  /**
   * 获取任务信息
   */
  getTask(taskId: string): M3U8DownloadTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): M3U8DownloadTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取下载进度
   */
  getProgress(taskId: string): number {
    const task = this.tasks.get(taskId);
    if (!task) return 0;

    if (task.rangeDownload.targetSegment === 0) return 0;
    return (task.finishNum / task.rangeDownload.targetSegment) * 100;
  }

  /**
   * 下载 TS 片段
   */
  private downloadTS(task: M3U8DownloadTask): void {
    const download = () => {
      const isPause = task.status === 'pause';
      const index = task.downloadIndex;

      if (index >= task.rangeDownload.endSegment || isPause) {
        return;
      }

      task.downloadIndex++;

      if (task.finishList[index] && task.finishList[index].status === '') {
        task.finishList[index].status = 'is-downloading';

        const xhr = new XMLHttpRequest();
        xhr.responseType = 'arraybuffer';
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              this.dealTS(task, xhr.response, index, () => {
                if (task.downloadIndex < task.rangeDownload.endSegment && !isPause) {
                  download();
                }
              });
            } else {
              task.errorNum++;
              task.finishList[index].status = 'is-error';
              this.options.onError?.(task, `片段 ${index} 下载失败`);

              if (task.downloadIndex < task.rangeDownload.endSegment) {
                !isPause && download();
              }
            }
          }
        };

        xhr.open('GET', task.tsUrlList[index], true);
        xhr.send();
        task.requests.push(xhr);
      } else if (task.downloadIndex < task.rangeDownload.endSegment) {
        !isPause && download();
      }
    };

    // 并发下载 6 个片段
    const concurrency = Math.min(6, task.rangeDownload.targetSegment - task.finishNum);
    for (let i = 0; i < concurrency; i++) {
      download();
    }
  }

  /**
   * 处理 TS 片段
   */
  private dealTS(
    task: M3U8DownloadTask,
    file: ArrayBuffer,
    index: number,
    callback: () => void
  ): void {
    let data = file;

    // AES 解密
    if (task.aesConf.key) {
      data = this.aesDecrypt(task, data, index);
    }

    // MP4 转码（如果需要）
    if (task.type === 'MP4') {
      this.conversionMp4(task, data, index, (convertedData) => {
        task.mediaFileList[index - task.rangeDownload.startSegment + 1] = convertedData;
        task.finishList[index].status = 'is-success';
        task.finishNum++;

        this.options.onProgress?.(task);

        if (task.finishNum === task.rangeDownload.targetSegment) {
          task.status = 'done';
          this.downloadFile(task);
          this.options.onComplete?.(task);
        }

        callback();
      });
    } else {
      task.mediaFileList[index - task.rangeDownload.startSegment + 1] = data;
      task.finishList[index].status = 'is-success';
      task.finishNum++;

      this.options.onProgress?.(task);

      if (task.finishNum === task.rangeDownload.targetSegment) {
        task.status = 'done';
        this.downloadFile(task);
        this.options.onComplete?.(task);
      }

      callback();
    }
  }

  /**
   * 下载文件
   */
  private downloadFile(task: M3U8DownloadTask): void {
    const fileBlob = new Blob(task.mediaFileList, {
      type: task.type === 'MP4' ? 'video/mp4' : 'video/MP2T',
    });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(fileBlob);
    a.download = `${task.title}.${task.type === 'MP4' ? 'mp4' : 'ts'}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /**
   * 获取 M3U8 文件
   */
  private async fetchM3U8(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.responseText);
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        }
      };
      xhr.open('GET', url, true);
      xhr.send();
    });
  }

  /**
   * 检测是否是主播放列表
   */
  private isMasterPlaylist(m3u8Str: string): boolean {
    return m3u8Str.includes('#EXT-X-STREAM-INF');
  }

  /**
   * 解析流信息
   */
  private parseStreamInfo(m3u8Str: string, baseUrl: string): Array<{
    url: string;
    bandwidth: number;
    resolution: string;
    name: string;
  }> {
    const streams: Array<{
      url: string;
      bandwidth: number;
      resolution: string;
      name: string;
    }> = [];
    const lines = m3u8Str.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidth = line.match(/BANDWIDTH=(\d+)/)?.[1] || '';
        const resolution = line.match(/RESOLUTION=([^\s,]+)/)?.[1] || '';
        const name = line.match(/NAME="([^"]+)"/)?.[1] || '';

        if (i + 1 < lines.length) {
          const url = lines[i + 1].trim();
          if (url && !url.startsWith('#')) {
            streams.push({
              url: this.applyURL(url, baseUrl),
              bandwidth: parseInt(bandwidth) || 0,
              resolution: resolution || 'Unknown',
              name: name || `${resolution || ''} ${bandwidth ? parseInt(bandwidth) / 1000 + 'kbps' : 'Unknown'}`,
            });
            i++;
          }
        }
      }
    }

    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    return streams;
  }

  /**
   * 合成 URL
   */
  private applyURL(targetURL: string, baseURL: string): string {
    if (targetURL.indexOf('http') === 0) {
      return targetURL;
    } else if (targetURL[0] === '/') {
      const domain = baseURL.split('/');
      return domain[0] + '//' + domain[2] + targetURL;
    } else {
      const domain = baseURL.split('/');
      domain.pop();
      return domain.join('/') + '/' + targetURL;
    }
  }

  /**
   * 解析 IV
   */
  private parseIV(ivString: string): Uint8Array {
    const hex = ivString.replace(/^0x/, '');
    return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  }

  /**
   * 获取 AES 密钥
   */
  private async getAESKey(task: M3U8DownloadTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.responseType = 'arraybuffer';
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            task.aesConf.key = xhr.response;
            // 初始化 AES 解密器
            task.aesConf.decryption = new AESDecryptor();
            task.aesConf.decryption.expandKey(task.aesConf.key);
            resolve();
          } else {
            reject(new Error('获取 AES 密钥失败'));
          }
        }
      };
      xhr.open('GET', task.aesConf.uri, true);
      xhr.send();
    });
  }

  /**
   * AES 解密
   */
  private aesDecrypt(task: M3U8DownloadTask, data: ArrayBuffer, index: number): ArrayBuffer {
    if (!task.aesConf.decryption) {
      return data;
    }

    // 使用 IV 或默认 IV
    let iv: Uint8Array;
    if (task.aesConf.iv) {
      iv = task.aesConf.iv;
    } else {
      // 如果没有指定 IV，使用片段索引作为 IV
      iv = new Uint8Array(16);
      for (let i = 12; i < 16; i++) {
        iv[i] = (index >> (8 * (15 - i))) & 0xff;
      }
    }

    try {
      return task.aesConf.decryption.decrypt(data, 0, iv.buffer, true);
    } catch (error) {
      console.error('AES 解密失败:', error);
      return data;
    }
  }

  /**
   * MP4 转码
   */
  private conversionMp4(
    task: M3U8DownloadTask,
    data: ArrayBuffer,
    index: number,
    callback: (data: ArrayBuffer) => void
  ): void {
    if (task.type === 'MP4') {
      try {
        // @ts-ignore - mux.js 的 Transmuxer 在 mp4 子模块下
        const transMuxer = new muxjs.mp4.Transmuxer({
          keepOriginalTimestamps: true,
          duration: parseInt(task.durationSecond.toString()),
        });

        transMuxer.on('data', (segment: any) => {
          // 第一个片段需要包含初始化段
          if (index === task.rangeDownload.startSegment - 1) {
            const combinedData = new Uint8Array(
              segment.initSegment.byteLength + segment.data.byteLength
            );
            combinedData.set(segment.initSegment, 0);
            combinedData.set(segment.data, segment.initSegment.byteLength);
            callback(combinedData.buffer);
          } else {
            callback(segment.data);
          }
        });

        transMuxer.push(new Uint8Array(data));
        transMuxer.flush();
      } catch (error) {
        console.error('MP4 转码失败:', error);
        // 转码失败，返回原始数据
        callback(data);
      }
    } else {
      // TS 格式直接返回
      callback(data);
    }
  }

  /**
   * 终止请求
   */
  private abortRequests(task: M3U8DownloadTask): void {
    task.requests.forEach((xhr) => {
      if (xhr.readyState !== 4) {
        xhr.abort();
      }
    });
    task.requests = [];
  }
}
