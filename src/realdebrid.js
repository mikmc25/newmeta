// Enhanced RealDebrid implementation with smart file selection
export class RealDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey.replace('rd=', '').trim();
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
        this.serviceName = 'RealDebrid';
    }

    static canHandle(apiKey) {
        return apiKey && apiKey.startsWith('rd=') && apiKey.length > 43;
    }

    async makeRequest(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${this.apiKey}`,
            'User-Agent': 'Stremio-Addon/1.0',
            ...options.headers
        };

        const response = await fetch(url, {
            method: options.method || 'GET',
            timeout: 15000,
            ...options,
            headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorObj;
            try {
                errorObj = JSON.parse(errorText);
            } catch {
                errorObj = { error: errorText, code: response.status };
            }
            throw errorObj;
        }

        return response.json();
    }

    // Test API key
    async testApiKey() {
        try {
            const user = await this.makeRequest('/user');
            console.log('✅ RD API key valid for user:', user.username);
            return true;
        } catch (error) {
            console.error('❌ RD API test failed:', error);
            return false;
        }
    }

    // Cache check - mark all as cached since endpoint is disabled
    async checkInstantAvailability(hashes) {
        console.log(`🔍 RD: Checking ${hashes.length} hashes (fallback - endpoint disabled)`);
        
        const results = {};
        hashes.forEach(hash => {
            results[hash.toLowerCase()] = {
                cached: true,
                files: []
            };
        });
        
        return results;
    }

    // ENHANCED: Main method with type/season/episode support
    async getCachedUrl(magnetLink, type = 'movie', season = null, episode = null) {
        try {
            console.log(`🧲 RD: Processing ${type}${season ? ` S${season}E${episode}` : ''}...`);
            
            // Extract hash from magnet
            const hashMatch = magnetLink.match(/btih:([a-f0-9]{40})/i);
            if (!hashMatch) {
                throw new Error('Invalid magnet link format');
            }
            const infoHash = hashMatch[1].toLowerCase();

            // Step 1: Create or find existing torrent
            const torrentId = await this.createOrFindTorrentId(infoHash, magnetLink);
            console.log('✅ RD: Got torrent ID:', torrentId);

            // Step 2: Get torrent info
            const torrent = await this.getTorrentInfo(torrentId);
            console.log('📊 RD: Torrent status:', torrent.status);

            // Step 3: Handle different statuses
            if (this.statusReady(torrent.status)) {
                return await this.unrestrictLink(torrent, type, season, episode);
            } else if (this.statusDownloading(torrent.status)) {
                throw new Error('Torrent is downloading - not cached');
            } else if (this.statusWaitingSelection(torrent.status)) {
                console.log('🎯 RD: Selecting files...');
                await this.selectTorrentFiles(torrent, type, season, episode);
                
                // Wait and check again
                await this.delay(3000);
                const updatedTorrent = await this.getTorrentInfo(torrentId);
                
                if (this.statusReady(updatedTorrent.status)) {
                    return await this.unrestrictLink(updatedTorrent, type, season, episode);
                } else {
                    throw new Error('Torrent not cached - downloading required');
                }
            } else {
                throw new Error(`Torrent not ready: ${torrent.status}`);
            }

        } catch (error) {
            console.error('❌ RD: getCachedUrl failed:', error);
            throw error;
        }
    }

    // Create or find existing torrent
    async createOrFindTorrentId(infoHash, magnetLink) {
        try {
            return await this.findTorrent(infoHash);
        } catch {
            return await this.createTorrentId(infoHash, magnetLink);
        }
    }

    // Find existing torrent
    async findTorrent(infoHash) {
        const torrents = await this.makeRequest('/torrents?page=1&limit=50');
        const foundTorrent = torrents.find(torrent => 
            torrent.hash.toLowerCase() === infoHash && 
            !this.statusError(torrent.status)
        );
        
        if (!foundTorrent) {
            throw new Error('No recent torrent found');
        }
        
        return foundTorrent.id;
    }

    // Create new torrent
    async createTorrentId(infoHash, magnetLink) {
        console.log('🔗 RD: Adding magnet to account...');
        
        const addResponse = await this.makeRequest('/torrents/addMagnet', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                magnet: magnetLink 
            }).toString()
        });

        return addResponse.id;
    }

    // Get torrent info
    async getTorrentInfo(torrentId) {
        return await this.makeRequest(`/torrents/info/${torrentId}`);
    }

    // ENHANCED: Select files based on content type
    async selectTorrentFiles(torrent, type = 'movie', season = null, episode = null) {
        if (!this.statusWaitingSelection(torrent.status)) {
            return torrent;
        }

        const videoFiles = torrent.files.filter(file => 
            this.isVideoFile(file.path) && file.bytes > 5 * 1024 * 1024 // > 5MB
        );

        if (videoFiles.length === 0) {
            throw new Error('No video files found');
        }

        let fileIds;

        if (type === 'movie') {
            // For movies, select best file (largest non-sample)
            const bestFile = this.findBestMovieFile(videoFiles);
            fileIds = bestFile ? [bestFile.id] : videoFiles.map(f => f.id);
            console.log(`🎬 RD: Selected movie file: ${bestFile?.path || 'all files'}`);
        } else if (type === 'series' && season && episode) {
            // For series, find specific episode
            const episodeFile = this.findEpisodeFile(videoFiles, season, episode);
            if (!episodeFile) {
                throw new Error(`Episode S${season}E${episode} not found in torrent`);
            }
            fileIds = [episodeFile.id];
            console.log(`📺 RD: Selected episode file: ${episodeFile.path}`);
        } else {
            // Fallback: select all video files
            fileIds = videoFiles.map(file => file.id);
            console.log(`📦 RD: Selected all ${fileIds.length} video files`);
        }

        const fileIdsString = fileIds.join(',');
        
        await this.makeRequest(`/torrents/selectFiles/${torrent.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                files: fileIdsString 
            }).toString()
        });

        console.log('✅ RD: Files selected:', fileIdsString);
        return torrent;
    }

    // ENHANCED: Unrestrict link with smart file selection
    async unrestrictLink(torrent, type = 'movie', season = null, episode = null) {
        const selectedVideoFiles = torrent.files.filter(file => 
            file.selected === 1 && this.isVideoFile(file.path)
        );

        if (selectedVideoFiles.length === 0) {
            throw new Error('No selected video files found');
        }

        let targetFile;

        if (type === 'movie') {
            // For movies, find the best file (largest non-sample)
            targetFile = this.findBestMovieFile(selectedVideoFiles);
            console.log(`🎬 RD: Using movie file: ${targetFile.path}`);
        } else if (type === 'series' && season && episode) {
            // For series, find the specific episode
            targetFile = this.findEpisodeFile(selectedVideoFiles, season, episode);
            if (!targetFile) {
                // Fallback to largest file if episode not found
                targetFile = selectedVideoFiles.reduce((largest, current) => 
                    current.bytes > largest.bytes ? current : largest
                );
                console.log(`⚠️ RD: Episode not found, using largest file: ${targetFile.path}`);
            } else {
                console.log(`📺 RD: Using episode file: ${targetFile.path}`);
            }
        } else {
            // Fallback: use largest file
            targetFile = selectedVideoFiles.reduce((largest, current) => 
                current.bytes > largest.bytes ? current : largest
            );
            console.log(`📦 RD: Using largest file: ${targetFile.path}`);
        }

        // Get the corresponding download link
        const fileIndex = torrent.files.indexOf(targetFile);
        const downloadLink = torrent.links[fileIndex];

        if (!downloadLink) {
            throw new Error('No download link available for selected file');
        }

        // Unrestrict the link
        console.log('🔓 RD: Unrestricting download link...');
        const unrestrictResponse = await this.makeRequest('/unrestrict/link', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                link: downloadLink 
            }).toString()
        });

        console.log('✅ RD: Got unrestricted link');
        return unrestrictResponse.download;
    }

    // ENHANCED: Find best movie file (from CF Worker logic)
    findBestMovieFile(files) {
        const scored = files.map(file => ({
            ...file,
            score: this.scoreMovieFile(file)
        }));

        scored.sort((a, b) => b.score - a.score);

        console.log('🎯 Top movie file candidates:');
        scored.slice(0, 3).forEach((f, i) => {
            const sizeMB = (f.bytes / (1024 * 1024)).toFixed(0);
            console.log(`  ${i + 1}. [Score: ${f.score}] ${sizeMB}MB - ${f.path}`);
        });

        return scored[0];
    }

    scoreMovieFile(file) {
        const filename = file.path.toLowerCase();
        let score = 100;

        // Prefer larger files (main movie vs extras)
        const sizeMB = file.bytes / (1024 * 1024);
        if (sizeMB > 500) score += 300;
        if (sizeMB > 1000) score += 200;
        if (sizeMB > 2000) score += 150;
        if (sizeMB > 5000) score += 100;

        // Penalty for extras/samples
        const badKeywords = [
            'sample', 'trailer', 'preview', 'extras', 'bonus',
            'deleted', 'behind', 'making', 'interview', 'featurette'
        ];
        if (badKeywords.some(kw => filename.includes(kw))) {
            score -= 800;
        }

        // Prefer shallow directory structure
        const pathDepth = file.path.split('/').length;
        if (pathDepth <= 2) score += 100;

        return score;
    }

    // ENHANCED: Find episode file with multiple patterns (from CF Worker logic)
    findEpisodeFile(files, targetSeason, targetEpisode) {
        console.log(`🔍 RD: Searching ${files.length} files for S${targetSeason}E${targetEpisode}`);

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
        for (const file of files) {
            const filename = file.path.toLowerCase();
            
            for (const pattern of episodePatterns) {
                if (pattern.test(filename)) {
                    console.log(`🎯 Exact match: ${file.path}`);
                    return file;
                }
            }
        }

        // Second pass: Loose matches
        const loosePatterns = [
            new RegExp(`s${targetSeason.toString().padStart(2, '0')}.*e${targetEpisode.toString().padStart(2, '0')}`, 'i'),
            new RegExp(`season.*${targetSeason}.*episode.*${targetEpisode}`, 'i')
        ];

        for (const file of files) {
            const filename = file.path.toLowerCase();
            
            // Skip samples
            if (/sample|trailer/i.test(filename)) continue;
            
            for (const pattern of loosePatterns) {
                if (pattern.test(filename)) {
                    console.log(`🔍 Loose match: ${file.path}`);
                    return file;
                }
            }
        }

        // Third pass: Season pack - find largest file from correct season
        const seasonPattern = new RegExp(`season\\s*${targetSeason}|s${targetSeason.toString().padStart(2, '0')}`, 'i');
        const seasonPackFiles = files.filter(file => {
            const filename = file.path.toLowerCase();
            return seasonPattern.test(filename) && !/sample|trailer/i.test(filename);
        });

        if (seasonPackFiles.length > 0) {
            console.log(`📦 Found ${seasonPackFiles.length} season pack files`);
            const largest = seasonPackFiles.reduce((largest, file) => 
                file.bytes > largest.bytes ? file : largest
            );
            console.log(`📦 Using largest season pack file: ${largest.path}`);
            return largest;
        }

        console.log('❌ No suitable episode file found');
        return null;
    }

    // Status check helpers
    statusError(status) {
        return ['error', 'magnet_error'].includes(status);
    }

    statusWaitingSelection(status) {
        return status === 'waiting_files_selection';
    }

    statusDownloading(status) {
        return ['downloading', 'uploading', 'queued'].includes(status);
    }

    statusReady(status) {
        return ['downloaded', 'dead'].includes(status);
    }

    // Check if file is video
    isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.ts', '.m2ts'];
        return videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
    }

    // Simple delay helper
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
