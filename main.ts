import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, normalizePath } from 'obsidian';
import * as JSZip from 'jszip';
import TurndownService from 'turndown';

// Remember to rename these classes and interfaces!

interface ImportGetNotesSettings {
	importFolder: string;
}

const DEFAULT_SETTINGS: ImportGetNotesSettings = {
	importFolder: 'get-notes'
}

export default class ImportGetNotesPlugin extends Plugin {
	settings: ImportGetNotesSettings;

	async onload() {
		await this.loadSettings();

		// 添加一个功能按钮到左侧边栏
		this.addRibbonIcon('folder-input', '导入get笔记', () => {
			new ImportModal(this.app, this).open();
		});

		// 添加设置选项卡
		this.addSettingTab(new ImportGetNotesSettingTab(this.app, this));

		// 添加命令
		this.addCommand({
			id: 'open-import-get-notes-modal',
			name: '打开导入get笔记对话框',
			callback: () => {
				new ImportModal(this.app, this).open();
			}
		});
	}

	onunload() {
		console.log('卸载导入get笔记插件');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ImportModal extends Modal {
	plugin: ImportGetNotesPlugin;
	file: File | null = null;

	constructor(app: App, plugin: ImportGetNotesPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('import-get-notes-modal');
		contentEl.createEl('h2', { text: '导入get笔记' });

		// 创建文件选择器
		const fileInput = contentEl.createEl('input', {
			type: 'file',
			attr: {
				accept: '.zip',
				name: 'zipFile'
			}
		});

		fileInput.addEventListener('change', (event) => {
			const target = event.target as HTMLInputElement;
			if (target.files && target.files.length > 0) {
				this.file = target.files[0];
			}
		});

		// 创建导入按钮
		const importButton = contentEl.createEl('button', {
			text: '导入',
			cls: 'mod-cta'
		});

		importButton.addEventListener('click', async () => {
			if (!this.file) {
				new Notice('请选择一个zip文件');
				return;
			}

			try {
				await this.processZipFile(this.file);
				this.close();
			} catch (error) {
				console.error('导入过程中出错:', error);
				new Notice(`导入失败: ${error.message}`);
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async processZipFile(file: File) {
		new Notice('开始导入...');
		
		// 读取zip文件
		const arrayBuffer = await file.arrayBuffer();
		const zip = await JSZip.loadAsync(arrayBuffer);
		
		// 创建Turndown服务用于HTML到Markdown的转换
		const turndownService = new TurndownService({
			headingStyle: 'atx',
			codeBlockStyle: 'fenced'
		});
		
		// 获取导入文件夹路径
		const importFolderPath = this.plugin.settings.importFolder;
		
		// 确保导入文件夹存在
		const folderExists = await this.app.vault.adapter.exists(importFolderPath);
		if (!folderExists) {
			await this.app.vault.createFolder(importFolderPath);
		}
		
		// 计数器
		let importedCount = 0;
		let errorCount = 0;
		
		// 处理zip中的文件
		const notesFiles = Object.keys(zip.files).filter(filename => 
			filename.startsWith('notes/') && 
			filename.endsWith('.html') && 
			!zip.files[filename].dir
		);
		
		for (const filename of notesFiles) {
			try {
				// 获取HTML内容
				const content = await zip.files[filename].async('text');
				
				// 从HTML中提取标题
				let title = this.extractTitleFromHtml(content);
				
				// 如果无法提取标题，则使用原始文件名
				if (!title) {
					title = filename.split('/').pop()?.replace('.html', '') || 'untitled';
				}
				
				// 确保文件名合法（移除不允许的字符）
				title = this.sanitizeFilename(title);
				
				// 从HTML中提取标签
				const tags = this.extractTagsFromHtml(content);
				
				// 从HTML中提取创建时间
				const createdTime = this.extractCreatedTimeFromHtml(content);
				
				// 转换为Markdown
				let markdown = turndownService.turndown(content);
				
				// 清理JavaScript代码片段和其他不需要的内容
				markdown = this.cleanupMarkdown(markdown);
				
				// 从Markdown中移除标签行
				markdown = this.removeTagsFromMarkdown(markdown);
				
				// 从Markdown中移除创建时间行
				markdown = this.removeCreatedTimeFromMarkdown(markdown);
				
				// 添加YAML前置元数据
				markdown = this.addYamlFrontMatter(markdown, title, tags, createdTime);
				
				// 创建新的Markdown文件
				const newFilePath = normalizePath(`${importFolderPath}/${title}.md`);
				
				// 创建文件
				await this.app.vault.create(newFilePath, markdown);
				
				importedCount++;
			} catch (error) {
				console.error(`处理文件 ${filename} 时出错:`, error);
				errorCount++;
			}
		}
		
		new Notice(`导入完成! 成功导入 ${importedCount} 个文件，失败 ${errorCount} 个文件。`);
	}
	
	// 清理标签文本，移除HTML标签和特殊字符
	cleanTagText(tag: string): string {
		// 移除HTML标签
		let cleaned = tag.replace(/<[^>]+>/g, '');
		
		// 移除HTML实体
		cleaned = cleaned.replace(/&[a-z]+;/g, '');
		
		// 移除常见的特殊字符和乱码
		cleaned = cleaned.replace(/[×\[\](){}|*&^%$#@!~`'"<>]/g, '');
		
		// 移除"class="、"span"等关键词
		cleaned = cleaned.replace(/class=/gi, '');
		cleaned = cleaned.replace(/span/gi, '');
		cleaned = cleaned.replace(/tag/gi, '');
		
		// 移除多余的空格
		cleaned = cleaned.replace(/\s+/g, ' ').trim();
		
		return cleaned;
	}
	
	// 从HTML中提取标签
	extractTagsFromHtml(html: string): string[] {
		const tags: string[] = [];
		
		// 尝试匹配常见的标签格式
		// 1. 匹配"标签："或"标签:"后面的内容
		const tagPatterns = [
			/标签[：:]\s*(.*?)(?:<\/|$|\n)/i,
			/tags[：:]\s*(.*?)(?:<\/|$|\n)/i,
			/关键词[：:]\s*(.*?)(?:<\/|$|\n)/i,
			/keywords[：:]\s*(.*?)(?:<\/|$|\n)/i
		];
		
		for (const pattern of tagPatterns) {
			const tagMatch = html.match(pattern);
			if (tagMatch && tagMatch[1]) {
				const tagText = tagMatch[1].trim();
				// 分割标签（可能以空格、逗号或分号分隔）
				const extractedTags = tagText.split(/[\s,;]+/).filter(tag => tag.trim().length > 0);
				tags.push(...extractedTags);
			}
		}
		
		// 2. 尝试匹配meta标签中的关键词
		const metaKeywordsMatch = html.match(/<meta\s+name=["']keywords["']\s+content=["'](.*?)["']/i);
		if (metaKeywordsMatch && metaKeywordsMatch[1]) {
			const keywordsText = metaKeywordsMatch[1].trim();
			// 关键词通常以逗号分隔
			const keywords = keywordsText.split(/,\s*/).filter(keyword => keyword.trim().length > 0);
			tags.push(...keywords);
		}
		
		// 3. 尝试匹配class为"tag"的元素
		const tagRegex = /<[^>]+class=["'][^"']*tag[^"']*["'][^>]*>(.*?)<\/[^>]+>/gi;
		let tagElementMatch;
		while ((tagElementMatch = tagRegex.exec(html)) !== null) {
			if (tagElementMatch[1]) {
				// 移除所有HTML标签，只保留文本内容
				const tagText = this.cleanHtmlContent(tagElementMatch[1]).trim();
				if (tagText) {
					tags.push(tagText);
				}
			}
		}
		
		// 4. 尝试匹配特定的标签容器 - 使用多行匹配但不使用 /s 标志
		const tagContainerRegex = /<div[^>]*class=["'][^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
		const tagContainerMatch = html.match(tagContainerRegex);
		if (tagContainerMatch && tagContainerMatch[1]) {
			const containerContent = tagContainerMatch[1];
			
			// 直接提取所有 span class="tag" 元素
			const spanTagRegex = /<span[^>]*class=["']tag["'][^>]*>(.*?)<\/span>/gi;
			let spanMatch;
			while ((spanMatch = spanTagRegex.exec(containerContent)) !== null) {
				if (spanMatch[1]) {
					const cleanTag = this.cleanHtmlContent(spanMatch[1]).trim();
					if (cleanTag) {
						tags.push(cleanTag);
					}
				}
			}
		}
		
		// 5. 尝试匹配Get笔记特有的标签格式
		if (html.includes('Get笔记') || html.includes('Get 笔记')) {
			// Get笔记是一个默认标签
			tags.push('Get笔记');
		}
		
		// 清理标签：移除HTML标签和特殊字符
		const cleanedTags = tags.map(tag => this.cleanTagText(tag))
			.filter(tag => tag.length > 0)
			.map(tag => {
				// 额外处理可能的引号问题
				return tag.replace(/^["']+|["']+$/g, '');
			});
		
		// 移除重复的标签并返回
		return [...new Set(cleanedTags)];
	}
	
	// 清理HTML内容，移除所有HTML标签
	cleanHtmlContent(html: string): string {
		// 移除所有HTML标签
		return html.replace(/<[^>]+>/g, '');
	}
	
	// 从HTML中提取创建时间
	extractCreatedTimeFromHtml(html: string): string | null {
		// 尝试匹配常见的创建时间格式
		const timePatterns = [
			/创建于[：:]\s*([\d-]+\s+[\d:]+)/i,
			/创建时间[：:]\s*([\d-]+\s+[\d:]+)/i,
			/created[：:]\s*([\d-]+\s+[\d:]+)/i,
			/创建于[：:]\s*([\d/]+\s+[\d:]+)/i,
			/创建时间[：:]\s*([\d/]+\s+[\d:]+)/i,
			/created[：:]\s*([\d/]+\s+[\d:]+)/i,
			/发布于[：:]\s*([\d-]+\s+[\d:]+)/i,
			/发布时间[：:]\s*([\d-]+\s+[\d:]+)/i,
			/published[：:]\s*([\d-]+\s+[\d:]+)/i,
			/日期[：:]\s*([\d-]+\s+[\d:]+)/i,
			/date[：:]\s*([\d-]+\s+[\d:]+)/i
		];
		
		for (const pattern of timePatterns) {
			const timeMatch = html.match(pattern);
			if (timeMatch && timeMatch[1]) {
				return this.formatDateTime(timeMatch[1].trim());
			}
		}
		
		// 尝试匹配meta标签中的创建时间
		const metaTimePatterns = [
			/<meta\s+name=["']created["']\s+content=["'](.*?)["']/i,
			/<meta\s+name=["']date["']\s+content=["'](.*?)["']/i,
			/<meta\s+name=["']published["']\s+content=["'](.*?)["']/i,
			/<meta\s+name=["']pubdate["']\s+content=["'](.*?)["']/i,
			/<meta\s+property=["']article:published_time["']\s+content=["'](.*?)["']/i
		];
		
		for (const pattern of metaTimePatterns) {
			const metaTimeMatch = html.match(pattern);
			if (metaTimeMatch && metaTimeMatch[1]) {
				return this.formatDateTime(metaTimeMatch[1].trim());
			}
		}
		
		// 尝试从文件修改时间中提取
		const modTimeMatch = html.match(/最后修改[：:]\s*([\d-]+\s+[\d:]+)/i);
		if (modTimeMatch && modTimeMatch[1]) {
			return this.formatDateTime(modTimeMatch[1].trim());
		}
		
		// 如果没有找到创建时间，使用当前时间
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		const seconds = String(now.getSeconds()).padStart(2, '0');
		
		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}
	
	// 格式化日期时间为统一格式
	formatDateTime(dateTimeStr: string): string {
		// 尝试解析各种格式的日期时间字符串
		let dateTime: Date | null = null;
		
		// 尝试解析ISO格式 (2023-03-03T12:34:56Z)
		if (dateTimeStr.includes('T')) {
			try {
				dateTime = new Date(dateTimeStr);
				if (!isNaN(dateTime.getTime())) {
					const year = dateTime.getFullYear();
					const month = String(dateTime.getMonth() + 1).padStart(2, '0');
					const day = String(dateTime.getDate()).padStart(2, '0');
					const hours = String(dateTime.getHours()).padStart(2, '0');
					const minutes = String(dateTime.getMinutes()).padStart(2, '0');
					const seconds = String(dateTime.getSeconds()).padStart(2, '0');
					return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
				}
			} catch (e) {
				// 解析失败，继续尝试其他格式
			}
		}
		
		// 尝试解析 YYYY-MM-DD HH:MM:SS 格式
		const isoPattern = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
		const isoMatch = dateTimeStr.match(isoPattern);
		if (isoMatch) {
			const year = isoMatch[1];
			const month = isoMatch[2].padStart(2, '0');
			const day = isoMatch[3].padStart(2, '0');
			const hours = (isoMatch[4] || '00').padStart(2, '0');
			const minutes = (isoMatch[5] || '00').padStart(2, '0');
			const seconds = (isoMatch[6] || '00').padStart(2, '0');
			return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
		}
		
		// 尝试解析 MM/DD/YYYY HH:MM:SS 格式
		const usPattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
		const usMatch = dateTimeStr.match(usPattern);
		if (usMatch) {
			const year = usMatch[3];
			const month = usMatch[1].padStart(2, '0');
			const day = usMatch[2].padStart(2, '0');
			const hours = (usMatch[4] || '00').padStart(2, '0');
			const minutes = (usMatch[5] || '00').padStart(2, '0');
			const seconds = (usMatch[6] || '00').padStart(2, '0');
			return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
		}
		
		// 如果无法解析，则返回原始字符串
		return dateTimeStr;
	}
	
	// 从Markdown中移除标签行
	removeTagsFromMarkdown(markdown: string): string {
		// 移除"标签："或"标签:"开头的行
		let cleaned = markdown.replace(/^标签[：:]\s*.*$/gm, '');
		// 移除"tags："或"tags:"开头的行
		cleaned = cleaned.replace(/^tags[：:]\s*.*$/gim, '');
		// 移除"关键词："或"关键词:"开头的行
		cleaned = cleaned.replace(/^关键词[：:]\s*.*$/gm, '');
		// 移除"keywords："或"keywords:"开头的行
		cleaned = cleaned.replace(/^keywords[：:]\s*.*$/gim, '');
		// 移除连续的空行
		cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
		
		return cleaned;
	}
	
	// 从Markdown中移除创建时间行
	removeCreatedTimeFromMarkdown(markdown: string): string {
		// 移除"创建于："或"创建于:"开头的行
		let cleaned = markdown.replace(/^创建于[：:]\s*.*$/gm, '');
		// 移除"创建时间："或"创建时间:"开头的行
		cleaned = cleaned.replace(/^创建时间[：:]\s*.*$/gm, '');
		// 移除"created："或"created:"开头的行
		cleaned = cleaned.replace(/^created[：:]\s*.*$/gim, '');
		// 移除"发布于："或"发布于:"开头的行
		cleaned = cleaned.replace(/^发布于[：:]\s*.*$/gm, '');
		// 移除"发布时间："或"发布时间:"开头的行
		cleaned = cleaned.replace(/^发布时间[：:]\s*.*$/gm, '');
		// 移除"published："或"published:"开头的行
		cleaned = cleaned.replace(/^published[：:]\s*.*$/gim, '');
		// 移除"日期："或"日期:"开头的行
		cleaned = cleaned.replace(/^日期[：:]\s*.*$/gm, '');
		// 移除"date："或"date:"开头的行
		cleaned = cleaned.replace(/^date[：:]\s*.*$/gim, '');
		// 移除连续的空行
		cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
		
		return cleaned;
	}
	
	// 添加YAML前置元数据
	addYamlFrontMatter(markdown: string, title: string, tags: string[], createdTime: string | null): string {
		let yaml = '---\n';
		yaml += `title: ${this.escapeYamlString(title)}\n`;
		
		if (createdTime) {
			yaml += `created: ${this.escapeYamlString(createdTime)}\n`;
		}
		
		if (tags.length > 0) {
			yaml += 'tags:\n';
			for (const tag of tags) {
				yaml += `  - ${this.escapeYamlString(tag)}\n`;
			}
		}
		
		yaml += '---\n\n';
		
		return yaml + markdown;
	}
	
	// 转义YAML字符串中的特殊字符
	escapeYamlString(str: string): string {
		// 如果字符串包含特殊字符，用引号包裹
		if (/[:#\[\]{}|>*&!%@,]/.test(str) || str.startsWith(' ') || str.endsWith(' ')) {
			return `"${str.replace(/"/g, '\\"')}"`;
		}
		return str;
	}
	
	// 从HTML内容中提取标题
	extractTitleFromHtml(html: string): string | null {
		// 尝试匹配<title>标签
		const titleMatch = html.match(/<title>(.*?)<\/title>/i);
		if (titleMatch && titleMatch[1]) {
			const title = titleMatch[1].trim();
			// 如果标题包含 " - Get笔记"，移除它
			return title.replace(/ - Get笔记$| - Get 笔记$/, '');
		}
		
		// 如果没有<title>标签，尝试匹配第一个<h1>标签
		const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
		if (h1Match && h1Match[1]) {
			// 移除可能的HTML标签
			return h1Match[1].replace(/<[^>]+>/g, '').trim();
		}
		
		// 尝试匹配meta标签中的标题
		const metaTitleMatch = html.match(/<meta\s+name=["']title["']\s+content=["'](.*?)["']/i);
		if (metaTitleMatch && metaTitleMatch[1]) {
			return metaTitleMatch[1].trim();
		}
		
		// 尝试匹配header或article中的第一个标题
		const headerTitleMatch = html.match(/<header[^>]*>[\s\S]*?<h\d[^>]*>(.*?)<\/h\d>/i);
		if (headerTitleMatch && headerTitleMatch[1]) {
			return headerTitleMatch[1].replace(/<[^>]+>/g, '').trim();
		}
		
		// 尝试匹配任何标题标签
		const anyHeadingMatch = html.match(/<h\d[^>]*>(.*?)<\/h\d>/i);
		if (anyHeadingMatch && anyHeadingMatch[1]) {
			return anyHeadingMatch[1].replace(/<[^>]+>/g, '').trim();
		}
		
		return null;
	}
	
	// 清理文件名，移除不允许的字符
	sanitizeFilename(filename: string): string {
		// 移除文件名中不允许的字符
		let sanitized = filename.replace(/[\\/:*?"<>|]/g, '-');
		
		// 限制文件名长度
		if (sanitized.length > 100) {
			sanitized = sanitized.substring(0, 100);
		}
		
		// 确保文件名不为空
		if (!sanitized.trim()) {
			sanitized = 'untitled';
		}
		
		return sanitized;
	}
	
	// 清理Markdown中的JavaScript代码片段和重复标题
	cleanupMarkdown(markdown: string): string {
		// 移除document.addEventListener等JavaScript代码片段
		markdown = markdown.replace(/document\.addEventListener\([^)]+\);?/g, '');
		markdown = markdown.replace(/window\.addEventListener\([^)]+\);?/g, '');
		markdown = markdown.replace(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\}/g, '');
		
		// 移除可能的其他JavaScript代码片段
		markdown = markdown.replace(/<script[\s\S]*?<\/script>/g, '');
		
		// 移除可能的内联JavaScript
		markdown = markdown.replace(/on\w+="[^"]*"/g, '');
		
		// 移除可能的HTML注释
		markdown = markdown.replace(/<!--[\s\S]*?-->/g, '');
		
		// 移除可能的HTML标签残留
		markdown = markdown.replace(/<\/?[a-z][^>]*>/gi, '');
		
		// 移除末尾的JavaScript函数调用
		markdown = markdown.replace(/\n*\w+\([^)]*\);?\s*$/g, '');
		
		// 处理重复标题问题
		const lines = markdown.split('\n');
		if (lines.length > 2) {
			// 检查第一行非空文本和第一个标题是否相似
			let firstTextLine = '';
			let firstHeadingLine = '';
			let firstHeadingIndex = -1;
			
			// 找到第一行非空文本
			for (let i = 0; i < lines.length; i++) {
				const trimmedLine = lines[i].trim();
				if (trimmedLine && !trimmedLine.startsWith('#')) {
					firstTextLine = trimmedLine;
					break;
				}
			}
			
			// 找到第一个标题行
			for (let i = 0; i < lines.length; i++) {
				const trimmedLine = lines[i].trim();
				if (trimmedLine.startsWith('# ')) {
					firstHeadingLine = trimmedLine.substring(2);
					firstHeadingIndex = i;
					break;
				}
			}
			
			// 如果找到了第一行文本和第一个标题，并且它们相似，则移除第一行文本
			if (firstTextLine && firstHeadingLine && this.areTextsSimilar(firstTextLine, firstHeadingLine)) {
				// 找到第一行文本的索引
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].trim() === firstTextLine) {
						lines.splice(i, 1);
						break;
					}
				}
			}
		}
		
		// 重新组合文本
		markdown = lines.join('\n');
		
		// 移除末尾的空行
		markdown = markdown.replace(/\n+$/g, '\n');
		
		return markdown;
	}
	
	// 检查两个文本是否相似（忽略标点符号和空格）
	areTextsSimilar(text1: string, text2: string): boolean {
		// 移除表情符号、标点符号和空格，并转换为小写进行比较
		const normalize = (text: string) => {
			return text
				.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
				.replace(/[^\w\s]/g, '')
				.replace(/\s+/g, '')
				.toLowerCase();
		};
		
		const normalizedText1 = normalize(text1);
		const normalizedText2 = normalize(text2);
		
		// 如果两个文本完全相同，或者一个是另一个的子串
		return normalizedText1 === normalizedText2 || 
			   normalizedText1.includes(normalizedText2) || 
			   normalizedText2.includes(normalizedText1);
	}
}

class ImportGetNotesSettingTab extends PluginSettingTab {
	plugin: ImportGetNotesPlugin;

	constructor(app: App, plugin: ImportGetNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('import-get-notes-settings');

		containerEl.createEl('h2', { text: '导入get笔记设置' });

		new Setting(containerEl)
			.setName('导入文件夹')
			.setDesc('指定导入的get笔记将存放的文件夹路径')
			.addText(text => text
				.setPlaceholder('例如: get-notes')
				.setValue(this.plugin.settings.importFolder)
				.onChange(async (value) => {
					this.plugin.settings.importFolder = value;
					await this.plugin.saveSettings();
				}));
	}
}
