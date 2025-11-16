// premiumize.js - Enhanced with CF Worker logic
import { ERROR } from './const.js';
import { BaseDebrid } from './base-debrid.js';

// File list cache
const fileCache = new Map();
const CACHE_TTL = 1800000; // 30 minutes

export class Premiumize extends BaseDebrid {
    #apiUrl = 'https://www.premiumize.me/api';
    #batchSize = 99;

    constructor(apiKey) {
        super(apiKey, 'pr');
        this.serviceName = 'Premiumize';
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('pr=');
    }

    async makeRequest(method, path, opts = {}) {
        const retries = 3;
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                const url = `${this.#apiUrl}${path}`;
                console.log(`🔷 Premiumize Request (Attempt ${i + 1}/${retries}):`, method, path);

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);

                const finalUrl = method === 'GET' 
                    ? `${url}${url.includes('?') ? '&' : '?'}apikey=${this.getKey()}`
                    : url;

                const response = await fetch(finalUrl, {
                    ...opts,
                    method,
                    signal: controller.signal
                });

                clearTimeout(timeout);
                console.log('Response Status:', response.status);

                const data = await response.json();

                if (data.status === 'error') {
                    if (data.message === 'Invalid API key.') {
                        throw new Error(ERROR.INVALID_API_KEY);
                    }
                    throw new Error(`API Error: ${data.message}`);
                }

                return data;

            } catch (error) {
                console.log(`Attempt ${i + 1} failed:`, error.message);
                lastError = error;
                if (i < retries - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        throw lastError;
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log(`\n🔍 Premiumize: Batch checking ${hashes.length} hashes`);

            const results = {};
            const batches = [];

            for (let i = 0; i < hashes.length; i += this.#batchSize) {
                batches.push(hashes.slice(i, i + this.#batchSize));
            }

            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                const params = new URLSearchParams();
                batch.forEach(hash => params.append('items[]', hash));

                const data = await this.makeRequest('GET', `/cache/check?${params}`);

                batch.forEach((hash, index) => {
                    results[hash] = {
                        cached: data.response[index],
                        files: [],
                        fileCount: 0,
                        service: 'Premiumize'
                    };
                });

                if (i < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            const cachedCount = Object.values(results).filter(r => r.cached).length;
            console.log(`✅ Premiumize: ${cachedCount}/${hashes.length} cached`);

            return results;

        } catch (error) {
            console.error('❌ Cache check failed:', error);
            return {};
        }
    }

    async getFileList(magnetLink) {
        const infoHash = this.extractInfoHash(magnetLink);
        const cacheKey = `files:${infoHash}`;
        
        // Check memory cache first
        if (fileCache.has(cacheKey)) {
            const cached = fileCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                console.log(`📂 Using cached file list for ${infoHash}`);
                return cached.data;
            }
            fileCache.delete(cacheKey);
        }

        try {
            const formData = new URLSearchParams();
            formData.append('src', magnetLink);
            formData.append('apikey', this.getKey());

            console.log(`📂 Getting file list via DirectDL...`);
            const data = await this.makeRequest('POST', '/transfer/directdl', {
                body: formData,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const files = (data.content || []).map(file => ({
                path: file.path,
                size: file.size,
                link: file.link,
                stream_link: file.stream_link || file.link,
                isVideo: /\.(mkv|mp4|avi|mov|wmv|m4v|webm)$/i.test(file.path),
                isSubtitle: /\.(srt|sub|ass|ssa|vtt)$/i.test(file.path),
                extension: file.path.split('.').pop().toLowerCase()
            }));

            // Cache the result
            fileCache.set(cacheKey, { data: files, timestamp: Date.now() });

            console.log(`📂 Found ${files.length} files (${files.filter(f => f.isVideo).length} videos)`);
            return files;

        } catch (error) {
            console.error('❌ Failed to get file list:', error);
            throw error;
        }
    }

    async getStreamUrl(magnetLink, type = 'movie', season = null, episode = null) {
        try {
            console.log(`\n🔥 Premiumize: Processing ${type}${season ? ` S${season}E${episode}` : ''}`);
            
            // Get file list via DirectDL
            const files = await this.getFileList(magnetLink);

            if (!files || files.length === 0) {
                throw new Error('No files found in torrent');
            }

            let selectedFile;

            if (type === 'movie') {
                selectedFile = this.findBestMovieFile(files);
            } else if (type === 'series') {
                if (!season || !episode) {
                    throw new Error('Season and episode required for series');
                }
                selectedFile = this.findEpisodeFile(files, season, episode);
            } else {
                selectedFile = this.findBestMovieFile(files);
            }

            if (!selectedFile) {
                throw new Error(`No suitable ${type === 'series' ? 'episode' : 'video'} file found`);
            }

            console.log(`✅ Selected file: ${selectedFile.path}`);
            console.log(`📦 Size: ${this.formatFileSize(selectedFile.size)}`);

            return selectedFile.stream_link || selectedFile.link;

        } catch (error) {
            console.error('❌ Premiumize getStreamUrl failed:', error);
            throw error;
        }
    }

    // MOVIE FILE SELECTION - From CF Worker
    findBestMovieFile(files) {
        const videoFiles = files.filter(f => f.isVideo);
        
        if (videoFiles.length === 0) {
            console.log('⚠️ No video files found');
            return null;
        }

        // Score each file
        const scored = videoFiles.map(file => ({
            ...file,
            score: this.scoreMovieFile(file)
        }));

        scored.sort((a, b) => b.score - a.score);

        console.log('🎯 Top movie file candidates:');
        scored.slice(0, 3).forEach((f, i) => {
            console.log(`  ${i + 1}. [Score: ${f.score}] ${this.formatFileSize(f.size)} - ${f.path}`);
        });

        return scored[0];
    }

    scoreMovieFile(file) {
        const filename = file.path.toLowerCase();
        let score = 100;

        // Prefer larger files (main movie vs extras)
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > 500) score += 300;
        if (sizeMB > 1000) score += 200;
        if (sizeMB > 2000) score += 150;
        if (sizeMB > 5000) score += 100;

        // Penalty for extras
        const badKeywords = [
            'sample', 'trailer', 'preview', 'extras', 'bonus',
            'deleted', 'behind', 'making', 'interview', 'featurette'
        ];
        if (badKeywords.some(kw => filename.includes(kw))) {
            score -= 800;
        }

        // Prefer certain formats
        if (file.extension === 'mkv') score += 50;
        if (file.extension === 'mp4') score += 40;

        // Prefer files in root or shallow directories
        const pathDepth = file.path.split('/').length;
        if (pathDepth <= 2) score += 100;

        return score;
    }

    // EPISODE FILE SELECTION - From CF Worker with Series Pack Support
    findEpisodeFile(files, targetSeason, targetEpisode) {
        const videoFiles = files.filter(f => f.isVideo);
        
        console.log(`🔍 Searching ${videoFiles.length} video files for S${targetSeason}E${targetEpisode}`);

        // Try multiple episode patterns
        const episodePatterns = [
            // Exact matches
            new RegExp(`s${targetSeason.toString().padStart(2, '0')}[.\\-\\s]?e${targetEpisode.toString().padStart(2, '0')}[^\\d]`, 'i'),
            new RegExp(`s${targetSeason}e${targetEpisode}`, 'i'),
            new RegExp(`season\\s*${targetSeason}.*episode\\s*${targetEpisode}`, 'i'),
            new RegExp(`${targetSeason}x${targetEpisode.toString().padStart(2, '0')}`, 'i'),
            new RegExp(`[^0-9]${targetSeason}${targetEpisode.toString().padStart(2, '0')}[^0-9]`, 'i')
        ];
        
        // First pass: Try exact matches
        for (const file of videoFiles) {
            const filename = file.path.toLowerCase();
            
            for (const pattern of episodePatterns) {
                if (pattern.test(filename)) {
                    console.log(`🎯 Exact match found: ${file.path}`);
                    return file;
                }
            }
        }

        // Second pass: Loose matches (for season packs)
        const loosePatterns = [
            new RegExp(`s${targetSeason.toString().padStart(2, '0')}.*e${targetEpisode.toString().padStart(2, '0')}`, 'i'),
            new RegExp(`season.*${targetSeason}.*episode.*${targetEpisode}`, 'i')
        ];

        for (const file of videoFiles) {
            const filename = file.path.toLowerCase();
            
            // Skip sample files
            if (/sample|trailer/i.test(filename)) continue;
            
            for (const pattern of loosePatterns) {
                if (pattern.test(filename)) {
                    console.log(`🔍 Loose match found: ${file.path}`);
                    return file;
                }
            }
        }

        // Third pass: Season pack detection - find largest file from correct season
        const seasonPattern = new RegExp(`season\\s*${targetSeason}|s${targetSeason.toString().padStart(2, '0')}`, 'i');
        const seasonPackFiles = videoFiles.filter(file => {
            const filename = file.path.toLowerCase();
            return seasonPattern.test(filename) && !/sample|trailer/i.test(filename);
        });

        if (seasonPackFiles.length > 0) {
            console.log(`📦 Found ${seasonPackFiles.length} potential season pack files`);
            // Return largest file (likely contains all episodes or full season)
            const largest = seasonPackFiles.reduce((largest, file) => 
                file.size > largest.size ? file : largest
            );
            console.log(`📦 Using largest season pack file: ${largest.path}`);
            return largest;
        }

        console.log('❌ No suitable episode file found');
        return null;
    }

    // Helper: Extract info hash
    extractInfoHash(magnetLink) {
        if (!magnetLink) return null;
        const match = magnetLink.match(/btih:([a-fA-F0-9]{40})/i);
        return match ? match[1].toUpperCase() : null;
    }

    // Helper: Format file size
    formatFileSize(bytes) {
        if (!bytes) return 'Unknown';
        const gb = bytes / (1024 ** 3);
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
    }

    // Helper: Extract metadata from filename
    extractMetadata(filename) {
        const name = filename.toLowerCase();
        const metadata = {
            quality: this.extractQuality(name),
            hdr: [],
            codec: null,
            audio: null
        };

        // HDR detection
        if (/hdr10\+/i.test(name)) metadata.hdr.push('HDR10+');
        else if (/hdr10/i.test(name)) metadata.hdr.push('HDR10');
        if (/dolby.?vision|dv/i.test(name)) metadata.hdr.push('DV');

        // Codec detection
        if (/[hx].?265|hevc/i.test(name)) metadata.codec = 'HEVC';
        else if (/[hx].?264|avc/i.test(name)) metadata.codec = 'H.264';
        else if (/av1/i.test(name)) metadata.codec = 'AV1';

        // Audio detection
        if (/atmos/i.test(name)) metadata.audio = 'Atmos';
        else if (/7\.1/i.test(name)) metadata.audio = '7.1';
        else if (/5\.1/i.test(name)) metadata.audio = '5.1';
        else if (/dts.?hd|dts-hd/i.test(name)) metadata.audio = 'DTS-HD';

        return metadata;
    }

    extractQuality(text) {
        if (/2160p|4k|uhd/i.test(text)) return '4K';
        if (/1080p|fhd/i.test(text)) return '1080p';
        if (/720p|hd/i.test(text)) return '720p';
        if (/480p|sd/i.test(text)) return '480p';
        return 'SD';
    }
}
