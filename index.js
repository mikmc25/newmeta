/**
 * DNS-resilient fetch wrapper to avoid ENOTFOUND errors from undici/Node.js DNS caching.
 */
import { lookup } from 'node:dns/promises';
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';

async function fetchWithSafeDNS(url, options = {}) {
    const { hostname } = new URL(url);
    const { address } = await lookup(hostname);
    const agent = url.startsWith('https')
        ? new https.Agent({ lookup: (_, __, cb) => cb(null, address, 4) })
        : new http.Agent({ lookup: (_, __, cb) => cb(null, address, 4) });
    return fetch(url, { ...options, agent });
}

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDebridServices } from './src/debrids.js';
import { RealDebrid } from './src/realdebrid.js';
import { Premiumize } from './src/premiumize.js';
import { TorBox } from './src/torbox.js';
import { isVideo, base64Encode, base64Decode, extractInfoHash, detectVideoFeatures, parseQuality, parseSize } from './src/util.js';
import { ERROR, STREAM_SOURCES } from './src/const.proxied.js';
import { checkRDCache } from './src/rdhelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Add this stream cache for fallback system
const streamCache = new Map(); // Store cached streams by content ID

// TMDB Integration (optional)
const TMDB_API_KEY = 'f051e7366c6105ad4f9aafe4733d9dae';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// ============================================
// ENHANCED METADATA EXTRACTION
// ============================================

class MetadataExtractor {
    static extractMetadata(filename) {
        const name = filename.toLowerCase();
        return {
            quality: this.extractQuality(name),
            hdr: this.extractHDR(name),
            codec: this.extractCodec(name),
            audio: this.extractAudio(name),
            source: this.extractSource(name),
            edition: this.extractEdition(name)
        };
    }

    static extractQuality(text) {
        if (/2160p|4k|uhd/i.test(text)) return '4K';
        if (/1080p|fhd|full.hd/i.test(text)) return '1080p';
        if (/720p|hd/i.test(text)) return '720p';
        if (/480p|sd/i.test(text)) return '480p';
        return 'SD';
    }

    static extractHDR(text) {
        const hdr = [];
        if (/hdr10\+|hdr10plus/i.test(text)) hdr.push('HDR10+');
        else if (/hdr10/i.test(text)) hdr.push('HDR10');
        if (/dolby.?vision|dovi|dv/i.test(text)) hdr.push('DV');
        return hdr;
    }

    static extractCodec(text) {
        if (/av1/i.test(text)) return 'AV1';
        if (/[hx].?265|hevc/i.test(text)) return 'HEVC';
        if (/[hx].?264|avc/i.test(text)) return 'H.264';
        return null;
    }

    static extractAudio(text) {
        if (/atmos/i.test(text)) return 'Atmos';
        if (/truehd/i.test(text)) return 'TrueHD';
        if (/dts.?hd|dts-hd/i.test(text)) return 'DTS-HD';
        if (/dts/i.test(text)) return 'DTS';
        if (/7\.1/i.test(text)) return '7.1';
        if (/5\.1/i.test(text)) return '5.1';
        return null;
    }

    static extractSource(text) {
        if (/remux/i.test(text)) return 'REMUX';
        if (/bluray|blu-ray/i.test(text)) return 'BluRay';
        if (/web.?dl/i.test(text)) return 'WEB-DL';
        if (/web.?rip/i.test(text)) return 'WEBRip';
        return null;
    }

    static extractEdition(text) {
        const editions = [];
        if (/extended/i.test(text)) editions.push('Extended');
        if (/director/i.test(text)) editions.push("Director's Cut");
        if (/imax/i.test(text)) editions.push('IMAX');
        return editions;
    }

    static formatSize(sizeString) {
        if (!sizeString) return null;
        if (/\d+\.?\d*\s*(GB|MB)/i.test(sizeString)) return sizeString;
        const bytes = parseInt(sizeString);
        if (!isNaN(bytes)) {
            const gb = bytes / (1024 ** 3);
            return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
        }
        return null;
    }

    static getQualitySymbol(quality) {
        const q = quality.toLowerCase();
        if (q.includes('4k') || q.includes('2160')) return '🔥';
        if (q.includes('1080')) return '⭐';
        if (q.includes('720')) return '✅';
        return '📺';
    }

    static buildQualityBadge(metadata) {
        let badge = metadata.quality.toUpperCase();
        if (metadata.hdr.length > 0) {
            badge += ` ${metadata.hdr.join('+')}`;
        }
        return badge;
    }

    static buildTechSpecs(metadata) {
        const specs = [
            metadata.codec,
            metadata.audio,
            metadata.source,
            ...metadata.edition
        ].filter(Boolean);
        return specs.length > 0 ? specs.join(' • ') : null;
    }
}

async function getTMDBDetails(imdbId) {
    try {
        const response = await fetch(
            `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
            { timeout: 5000 }
        );
        
        if (!response.ok) return null;
        
        const data = await response.json();
        
        if (data.movie_results?.[0]) {
            const movie = data.movie_results[0];
            return {
                title: movie.title,
                year: movie.release_date ? movie.release_date.substring(0, 4) : '',
                type: 'movie'
            };
        }
        
        if (data.tv_results?.[0]) {
            const show = data.tv_results[0];
            return {
                title: show.name,
                year: show.first_air_date ? show.first_air_date.substring(0, 4) : '',
                type: 'series'
            };
        }
        
        return null;
    } catch (error) {
        console.error('TMDB error:', error.message);
        return null;
    }
}

// ID type detection helper - FIXED VERSION
function getIdType(id) {
    if (id.startsWith('tt')) return 'imdb';
    if (id.startsWith('tmdb-')) return 'tmdb';  // Handle tmdb-XXXXX format
    if (/^\d+$/.test(id)) return 'tmdb';        // Handle pure numeric TMDB IDs
    return null;
}

// Function to get appropriate quality symbol based on quality value
function getQualitySymbol(quality) {
    // Convert quality to lowercase for case-insensitive matching
    const qualityStr = String(quality).toLowerCase();
    
    // Return symbol based on quality
    if (qualityStr.includes('2160') || qualityStr.includes('4k') || qualityStr.includes('uhd')) {
        return '🗣💨'; // 4K/UHD content
    } else if (qualityStr.includes('1080')) {
        return '🙊'; // Full HD
    } else if (qualityStr.includes('720')) {
        return '🙉'; // HD
    } else if (qualityStr.includes('480')) {
        return '🤬'; // SD
    } else if (qualityStr.includes('cam') || qualityStr.includes('hdts')) {
        return '📹'; // CAM/TS quality
    } else {
        return '🙈'; // Default/unknown quality
    }
}

// Add this helper function for episode filtering
function filterEpisodeResults(results, season, episode) {
    if (!season || !episode) return results;
    
    const targetSeason = parseInt(season);
    const targetEpisode = parseInt(episode);
    
    return results.filter(result => {
        const title = (result.title || result.filename || '').toLowerCase();
        
        // Extract season and episode numbers from the title
        const seasonMatches = title.match(/s(\d{1,2})/gi) || [];
        const episodeMatches = title.match(/e(\d{1,2})/gi) || [];
        
        // Also check for SxxExx format
        const sxxexxMatch = title.match(/s(\d{1,2})e(\d{1,2})/i);
        
        if (sxxexxMatch) {
            const foundSeason = parseInt(sxxexxMatch[1]);
            const foundEpisode = parseInt(sxxexxMatch[2]);
            return foundSeason === targetSeason && foundEpisode === targetEpisode;
        }
        
        // Check individual S and E patterns
        const seasons = seasonMatches.map(match => parseInt(match.replace(/s/i, '')));
        const episodes = episodeMatches.map(match => parseInt(match.replace(/e/i, '')));
        
        // Must contain the exact season and episode
        return seasons.includes(targetSeason) && episodes.includes(targetEpisode) &&
               seasons.length === 1 && episodes.length === 1; // Ensure only one season/episode match
    });
}

function sortStreams(streams) {
    return streams.sort((a, b) => {
        // Parse quality and size from stream names
        const qualityA = parseQuality(a.name);
        const qualityB = parseQuality(b.name);
        const sizeA = parseSize(a.name);
        const sizeB = parseSize(b.name);

        // Group by quality first
        if (qualityA !== qualityB) {
            return qualityB - qualityA; // Higher quality first
        }

        // If same quality, prefer reasonable file sizes
        // For each quality level, define ideal size ranges (in MB)
        const idealSizeRanges = {
            2160: { min: 10000, max: 80000 },   // 10GB - 80GB for 4K
            1080: { min: 2000, max: 16000 },    // 2GB - 16GB for 1080p
            720: { min: 1000, max: 8000 },      // 1GB - 8GB for 720p
            480: { min: 500, max: 4000 }        // 500MB - 4GB for 480p
        };

        const idealRange = idealSizeRanges[qualityA] || { min: 0, max: Infinity };

        // Calculate how far each size is from the ideal range
        const getIdealScore = (size, range) => {
            if (size >= range.min && size <= range.max) return 0;
            if (size < range.min) return range.min - size;
            return size - range.max;
        };

        const scoreA = getIdealScore(sizeA, idealRange);
        const scoreB = getIdealScore(sizeB, idealRange);

        // Sort by how close they are to ideal range
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }

        // If everything else is equal, prefer larger size
        return sizeB - sizeA;
    });
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.options('*', cors());

// Configuration page endpoint
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Root manifest endpoint
app.get('/manifest.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const manifest = {
        id: 'org.magnetio.hy',
        version: '2.0.0',
        name: '🅷 🅈 🅸💁☘︎',
        description: 'Stream movies and series via Debrid services - Configuration Required',
        resources: [],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true,
            configurationURL: `${baseUrl}/configure`
        }
    };
    res.json(manifest);
});

// Configured manifest endpoint
app.get('/:apiKeys/manifest.json', (req, res) => {
    const { apiKeys } = req.params;
    const debridServices = getDebridServices(apiKeys);
    
    // Check if we have valid API keys
    if (!debridServices.length) {
        return res.json({
            id: 'org.magnetio.hy',
            version: '2.0.0',
            name: '🅷 🅈 🅸💁☘︎',
            description: 'Invalid API keys provided - Please check your configuration',
            resources: [],
            types: ['movie', 'series'],
            idPrefixes: ['tt', 'tmdb'],
            catalogs: [],
            behaviorHints: {
                configurable: true,
                configurationRequired: true,
                configurationURL: `${req.protocol}://${req.get('host')}/configure`
            }
        });
    }

    // Return full manifest with streaming capabilities
    const manifest = {
        id: 'org.magnetio.hy',
        version: '2.0.0',
        name: '🅷 🅈 🅸☘︎',
        description: 'Stream movies and series via Debrid services',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            adult: true
        }
    };
    res.json(manifest);
});

async function checkCacheStatuses(service, streams) {
    if (!streams?.length) return {};

    try {
        const validStreams = streams.filter(stream => stream && stream.hash);
        if (!validStreams.length) return {};

        const hashes = validStreams.map(stream => stream.hash.toLowerCase());
        const results = await service.checkCacheStatuses(hashes);

        const cacheMap = {};
        validStreams.forEach(stream => {
            if (!stream || !stream.hash) return;

            const hash = stream.hash.toLowerCase();
            const result = results[hash];

            if (!result) return;

            let quality = stream.quality || '';
            if (!quality) {
                const qualityMatch = stream.filename?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i);
                if (qualityMatch) quality = qualityMatch[0];
            }

            let size = stream.size || '';
            if (!size) {
                const sizeMatch = stream.filename?.match(/\d+(\.\d+)?\s*(GB|MB)/i);
                if (sizeMatch) size = sizeMatch[0];
            }

            cacheMap[hash] = {
                ...result,
                hash,
                magnetLink: stream.magnetLink,
                filename: stream.filename || 'Unknown',
                websiteTitle: stream.websiteTitle || stream.filename || 'Unknown',
                quality,
                size,
                source: stream.source || 'Unknown',
                cached: result.cached !== false
            };
        });

        return cacheMap;
    } catch (error) {
        console.error('Cache check error:', error);
        return {};
    }
}

// OPTIMIZED STREAM ENDPOINT - MAJOR PERFORMANCE IMPROVEMENTS
app.get('/:apiKeys/stream/:type/:id.json', async (req, res) => {
    const { apiKeys, type, id } = req.params;
    const startTime = Date.now();
    
    try {
        // ✅ INITIALIZE SERVICES FROM URL PARAMETER (NOT GLOBAL)
        const debridServices = getDebridServices(apiKeys);
        
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        console.log(`\n🔐 Using ${debridServices.length} service(s): ${debridServices.map(s => s.constructor.name).join(', ')}`);

        let tmdbId = id;
        let season = null;
        let episode = null;

        // Handle series ID format
        if (type === 'series') {
            [tmdbId, season, episode] = id.split(':');
        }

        const idType = getIdType(tmdbId);
        if (!idType) {
            console.error('Invalid ID format:', tmdbId);
            return res.json({ streams: [] });
        }

        console.log(`Processing ${idType.toUpperCase()} ID: ${tmdbId}`);

        // Create unique cache key for this content
        const cacheKey = `${type}-${tmdbId}${season ? `-s${season}e${episode}` : ''}`;

        // STEP 1: Fetch streams with timeout (max 15 seconds)
        console.log('📡 Fetching streams from APIs...');
        const streamFetchPromise = Promise.race([
            getStreams(type, tmdbId, season, episode),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Stream fetch timeout')), 15000)
            )
        ]);

        const newStreams = await streamFetchPromise;
        
        if (!newStreams.length) {
            console.log('No streams found');
            return res.json({ streams: [] });
        }
        
        console.log(`Found ${newStreams.length} streams (${Date.now() - startTime}ms)`);
        
        // STEP 2: Process all services in parallel with aggressive timeouts
        const CACHE_CHECK_TIMEOUT = 20000; // 20 seconds max per service
        const MAX_STREAMS_TO_PROCESS = 100; // Limit streams to process
        
        // Limit streams to most promising ones first
        const limitedStreams = newStreams
            .sort((a, b) => {
                // Prioritize by quality and reasonable file size
                const qualityA = parseQuality(a.filename || '');
                const qualityB = parseQuality(b.filename || '');
                if (qualityA !== qualityB) return qualityB - qualityA;
                
                const sizeA = parseSize(a.filename || '');
                const sizeB = parseSize(b.filename || '');
                return Math.abs(sizeA - 5000) - Math.abs(sizeB - 5000); // Prefer ~5GB files
            })
            .slice(0, MAX_STREAMS_TO_PROCESS);

        console.log(`Processing top ${limitedStreams.length} streams for cache check`);

        const cacheCheckPromises = debridServices.map(async (service) => {
            const serviceName = service.constructor?.name || 'UnknownDebrid';
            console.log(`🔍 Checking cache with ${serviceName}`);

            try {
                // Race cache check against timeout
                const cacheCheckPromise = (async () => {
                    if (serviceName === 'RealDebrid' || service.serviceName === 'RealDebrid') {
                        return await checkRDCache(service, limitedStreams);
                    } else if (typeof service.checkCacheStatuses === 'function') {
                        return await checkCacheStatuses(service, limitedStreams);
                    } else {
                        console.warn(`⚠️ ${serviceName} does not support checkCacheStatuses`);
                        return {};
                    }
                })();

                const cacheMap = await Promise.race([
                    cacheCheckPromise,
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error(`${serviceName} cache check timeout`)), CACHE_CHECK_TIMEOUT)
                    )
                ]);

                const cachedCount = Object.values(cacheMap).filter(r => r.cached).length;
                console.log(`${serviceName}: ${cachedCount} cached out of ${limitedStreams.length} (${Date.now() - startTime}ms)`);

                // Convert to service streams quickly
                const serviceStreams = Object.values(cacheMap)
                    .filter(stream => stream && stream.hash && stream.cached)
                    .map(stream => ({
                        stream,
                        service: serviceName,
                        hash: stream.hash.toLowerCase()
                    }));

                return { serviceName, streams: serviceStreams, success: true };
            } catch (err) {
                console.error(`❌ ${serviceName} failed: ${err.message}`);
                return { serviceName, streams: [], success: false };
            }
        });

        // STEP 3: Wait for cache checks with overall timeout
        console.log('⏱️ Waiting for cache checks...');
        const OVERALL_TIMEOUT = 30000; // 30 seconds total timeout
        
        const cacheResults = await Promise.race([
            Promise.allSettled(cacheCheckPromises),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Overall cache check timeout')), OVERALL_TIMEOUT)
            )
        ]);

        // Process results (even if some failed)
        const allProcessedStreams = [];
        let successfulServices = 0;

        cacheResults.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.success) {
                const { serviceName, streams } = result.value;
                allProcessedStreams.push(...streams);
                successfulServices++;
                console.log(`✅ ${serviceName}: Added ${streams.length} streams`);
            } else {
                const serviceName = debridServices[index]?.constructor?.name || 'Unknown';
                console.log(`❌ ${serviceName}: Failed or timed out`);
            }
        });
        
        console.log(`Cache check completed: ${successfulServices}/${debridServices.length} services successful (${Date.now() - startTime}ms)`);
        
        if (!allProcessedStreams.length) {
            console.log('No cached streams found from any service');
            return res.json({ streams: [] });
        }

        // STEP 4: Store for fallback (don't wait)
        const cachedStreamsForFallback = allProcessedStreams.map(({ stream, service }) => ({
            hash: stream.hash,
            magnetLink: stream.magnetLink,
            filename: stream.filename,
            websiteTitle: stream.websiteTitle,
            quality: stream.quality,
            size: stream.size,
            source: stream.source,
            service: service
        }));
        
        // Store asynchronously (don't block response)
        setImmediate(() => {
            streamCache.set(cacheKey, cachedStreamsForFallback);
            console.log(`🗃️ Stored ${cachedStreamsForFallback.length} streams for fallback`);
        });
        
        // STEP 5: Format streams quickly
        console.log(`📝 Formatting ${allProcessedStreams.length} streams...`);
        const formattedStreams = [];
        
        for (const { stream, service } of allProcessedStreams) {
            try {
                // Quick validation
                if (!stream?.magnetLink || !stream?.filename) continue;
                
                // Fast feature detection (simplified)
                const filename = stream.filename.toLowerCase();
                const features = [];
                if (filename.includes('hdr')) features.push('HDR');
                if (filename.includes('dolby')) features.push('Dolby');
                if (filename.includes('atmos')) features.push('Atmos');
                if (filename.includes('x265') || filename.includes('hevc')) features.push('HEVC');
                
                const featureStr = features.length ? features.join(' | ') : '';
                const qualityDisplay = stream.quality ? stream.quality.toUpperCase() : '';
                const qualitySymbol = getQualitySymbol(qualityDisplay || stream.filename);
                
                const streamName = [
                    qualitySymbol,
                    qualityDisplay, 
                    stream.size,
                    service,
                    '𝐇𝐘-𝐈☘︎̤̮'
                ].filter(Boolean).join(' | ');
                
                const streamTitle = [
                    stream.filename,
                    [`🦉 ${stream.source}`, featureStr].filter(Boolean).join(' | ')
                ].filter(Boolean).join('\n');
                
                // Encode data for URL
                const encodedData = base64Encode(JSON.stringify({
                    magnetLink: stream.magnetLink,
                    cacheKey: cacheKey
                }));
                
                formattedStreams.push({
                    name: streamName,
                    title: streamTitle,
                    url: `${req.protocol}://${req.get('host')}/${apiKeys}/${encodedData}`,
                    service: service,
                    quality: parseQuality(stream.filename || ''),
                    size: parseSize(stream.filename || '')
                });
                
            } catch (error) {
                console.error(`Error formatting stream:`, error);
                continue;
            }
        }
        
        // STEP 6: Quick sort and send
        const sortedStreams = formattedStreams
            .sort((a, b) => {
                // Quick sort by quality then size
                if (a.quality !== b.quality) return b.quality - a.quality;
                return b.size - a.size;
            })
            .slice(0, 50); // Limit to top 50 streams
        
        const totalTime = Date.now() - startTime;
        console.log(`✅ Sending ${sortedStreams.length} streams (${totalTime}ms total)`);
        
        res.json({ streams: sortedStreams });
        
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.error(`❌ Error in stream endpoint (${totalTime}ms):`, error.message);
        res.status(500).json({ 
            streams: [],
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// OPTIMIZED getStreams function with better timeout handling
async function getStreams(type, id, season = null, episode = null) {
    try {
        console.log('🔄 Fetching streams from APIs');
        
        let query;
        const idType = getIdType(id);
        if (!idType) {
            console.error('Invalid ID format:', id);
            return [];
        }

        // Extract the actual ID number from tmdb-XXXXX format
        let actualId = id;
        if (id.startsWith('tmdb-')) {
            actualId = id.replace('tmdb-', '');
        }

        if (type === 'series') {
            if (!season || !episode) throw new Error('Season and episode required for series');
            query = `${actualId}:${season}:${episode}`;
        } else {
            query = actualId;
        }

        // Fetch from APIs with aggressive timeout
        const API_TIMEOUT = 8000; // 8 seconds per API
        const fetchPromises = Object.values(STREAM_SOURCES).map(async (source) => {
            try {
                const apiUrl = `${source.url}/api/search?type=${type}&query=${encodeURIComponent(query)}`;
                
                const fetchPromise = fetch(apiUrl, { 
                    headers: { 'User-Agent': 'Stremio-Magnetio-Addon/1.0' }
                });
                
                // Race against timeout
                const response = await Promise.race([
                    fetchPromise,
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error(`${source.name} timeout`)), API_TIMEOUT)
                    )
                ]);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                if (!data?.results?.length) {
                    return [];
                }

                console.log(`${source.name}: ${data.results.length} results`);
                
                let results = data.results.map(result => ({
                    ...result,
                    source: source.name
                }));
                
                // Quick episode filtering for series
                if (type === 'series' && season && episode) {
                    const seasonNum = parseInt(season);
                    const episodeNum = parseInt(episode);
                    results = results.filter(result => {
                        const title = (result.title || result.filename || '').toLowerCase();
                        const sxxexx = title.match(/s(\d{1,2})e(\d{1,2})/i);
                        if (sxxexx) {
                            return parseInt(sxxexx[1]) === seasonNum && parseInt(sxxexx[2]) === episodeNum;
                        }
                        return false;
                    });
                }
                
                return results;
            } catch (error) {
                console.error(`${source.name} failed: ${error.message}`);
                return [];
            }
        });

        // Wait for all APIs with overall timeout
        const allResults = await Promise.race([
            Promise.allSettled(fetchPromises),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('All APIs timeout')), 12000)
            )
        ]);

        // Process results quickly
        const seenMagnets = new Set();
        const combinedResults = [];

        allResults.forEach(result => {
            if (result.status === 'fulfilled') {
                result.value.forEach(stream => {
                    if (!stream?.magnetLink) return;

                    const hash = stream.magnetLink.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
                    if (!hash || seenMagnets.has(hash)) return;
                    seenMagnets.add(hash);

                    const quality = stream.quality || 
                                  stream.title?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i)?.[0] || '';
                    const size = stream.size || 
                               stream.title?.match(/\d+(\.\d+)?\s*(GB|MB)/i)?.[0] || '';
                    const filename = stream.filename || stream.title?.split('\n')[0]?.trim() || 'Unknown';
                    
                    combinedResults.push({
                        hash,
                        magnetLink: stream.magnetLink,
                        filename,
                        websiteTitle: stream.title || filename,
                        quality,
                        size,
                        source: stream.source || 'Unknown'
                    });
                });
            }
        });

        console.log(`Found ${combinedResults.length} unique streams`);
        return combinedResults;
    } catch (error) {
        console.error('❌ Error fetching streams:', error.message);
        return [];
    }
}

// OPTIMIZED getValidStreamingUrl with type/season/episode support
async function getValidStreamingUrl(service, magnetLink, hash, type = 'movie', season = null, episode = null) {
    const serviceName = service.constructor.name;
    
    try {
        let streamUrl;
        
        if (service instanceof RealDebrid) {
            // Use enhanced method with type/season/episode
            streamUrl = await service.getCachedUrl(magnetLink, type, season, episode);
            
        } else if (service instanceof TorBox) {
            streamUrl = await service.getStreamUrl(magnetLink);
            
        } else if (service instanceof Premiumize) {
            streamUrl = await service.getStreamUrl(magnetLink, type, season, episode);
            
        } else {
            streamUrl = await service.getStreamUrl(magnetLink);
        }
        
        // Simple URL validation only
        if (!streamUrl || !streamUrl.startsWith('http')) {
            return null;
        }
        
        console.log(`✅ ${serviceName}: Got streaming URL`);
        return streamUrl;
        
    } catch (error) {
        if (error.message === ERROR.NOT_PREMIUM) {
            return null;
        }
        if (error.message.includes('active download limit') || error.message.includes('ACTIVE_LIMIT')) {
            return null;
        }
        console.error(`❌ ${serviceName} error:`, error.message);
        return null;
    }
}

// IMPROVED MAGNET HANDLER WITH ENHANCED PREMIUMIZE SUPPORT
app.get('/:apiKeys/:encodedData', async (req, res) => {
    const { apiKeys, encodedData } = req.params;

    try {
        // ✅ INITIALIZE SERVICES FROM URL PARAMETER (NOT GLOBAL)
        const debridServices = getDebridServices(apiKeys);
        
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        console.log('\n🧲 Processing magnet request with fallback');
        console.log(`🔐 Using ${debridServices.length} service(s): ${debridServices.map(s => s.constructor.name).join(', ')}`);
        
        // Decode the data (could be old format or new format)
        let decodedData;
        let magnetLink;
        let cacheKey;
        let contentType = 'movie'; // default
        let season = null;
        let episode = null;
        
        try {
            // Try new format first (JSON with magnetLink and cacheKey)
            decodedData = JSON.parse(base64Decode(encodedData));
            magnetLink = decodedData.magnetLink;
            cacheKey = decodedData.cacheKey;
            
            // Extract type/season/episode from cacheKey for Premiumize
            // cacheKey format: "series-tt1234567-s1e5" or "movie-tt1234567"
            if (cacheKey) {
                if (cacheKey.startsWith('series-')) {
                    const parts = cacheKey.match(/series-.*-s(\d+)e(\d+)/i);
                    if (parts) {
                        contentType = 'series';
                        season = parseInt(parts[1]);
                        episode = parseInt(parts[2]);
                        console.log(`📺 Detected series: S${season}E${episode}`);
                    }
                } else if (cacheKey.startsWith('movie-')) {
                    contentType = 'movie';
                    console.log('🎬 Detected movie');
                }
            }
        } catch (e) {
            // Fall back to old format (just magnet link)
            magnetLink = base64Decode(encodedData);
            console.log('📼 Using legacy magnet format');
        }

        const hash = extractInfoHash(magnetLink)?.toLowerCase();
        if (!hash) {
            throw new Error('Invalid magnet link - no BTIH hash found');
        }

        console.log(`Primary hash: ${hash}`);
        if (cacheKey) {
            console.log(`Cache key: ${cacheKey}`);
        }

        // Step 1: Try the originally requested stream with all services
        console.log('\n🎯 Trying original requested stream...');
        for (const service of debridServices) {
            const serviceName = service.constructor?.name || 'UnknownDebrid';
            console.log(`Trying ${serviceName} for original stream`);
            
            // Check if it's Premiumize and use enhanced method
            if (serviceName === 'Premiumize' && contentType === 'series' && season && episode) {
                try {
                    console.log(`🔷 Using enhanced Premiumize with episode detection`);
                    const streamUrl = await service.getStreamUrl(
                        magnetLink, 
                        contentType, 
                        season, 
                        episode
                    );
                    if (streamUrl) {
                        console.log(`✅ Success with ${serviceName} - redirecting to original stream`);
                        return res.redirect(streamUrl);
                    }
                } catch (error) {
                    console.log(`❌ ${serviceName} failed: ${error.message}`);
                    continue;
                }
            } else if (serviceName === 'Premiumize') {
                // Use enhanced method for movies too
                try {
                    console.log(`🔷 Using enhanced Premiumize for movie`);
                    const streamUrl = await service.getStreamUrl(magnetLink, 'movie');
                    if (streamUrl) {
                        console.log(`✅ Success with ${serviceName} - redirecting to original stream`);
                        return res.redirect(streamUrl);
                    }
                } catch (error) {
                    console.log(`❌ ${serviceName} failed: ${error.message}`);
                    continue;
                }
            } else {
                // Use standard method for other services (RealDebrid, TorBox, DebridLink)
                const streamUrl = await getValidStreamingUrl(service, magnetLink, hash, contentType, season, episode);
                if (streamUrl) {
                    console.log(`✅ Success with ${serviceName} - redirecting to original stream`);
                    return res.redirect(streamUrl);
                }
            }
        }

        // Step 2: Try fallback streams if we have them stored
        if (cacheKey && streamCache.has(cacheKey)) {
            const cachedStreams = streamCache.get(cacheKey);
            console.log(`\n🔄 Original stream failed, trying ${cachedStreams.length} fallback streams...`);
            
            // Sort fallback streams by quality (best first)
            const sortedFallbacks = cachedStreams
                .filter(stream => stream.hash !== hash) // Skip the one we already tried
                .sort((a, b) => {
                    const qualityA = parseQuality(a.filename || '');
                    const qualityB = parseQuality(b.filename || '');
                    return qualityB - qualityA; // Higher quality first
                });

            console.log(`Trying ${sortedFallbacks.length} fallback streams`);

            // Try each fallback stream
            for (let i = 0; i < sortedFallbacks.length; i++) {
                const fallbackStream = sortedFallbacks[i];
                console.log(`\n🔄 Trying fallback ${i + 1}/${sortedFallbacks.length}: ${fallbackStream.filename}`);

                // Try this fallback stream with all services
                for (const service of debridServices) {
                    const serviceName = service.constructor?.name || 'UnknownDebrid';
                    console.log(`Checking ${serviceName} for fallback stream`);

                    // Use appropriate method based on service type
                    if (serviceName === 'Premiumize' && contentType === 'series' && season && episode) {
                        try {
                            const streamUrl = await service.getStreamUrl(
                                fallbackStream.magnetLink, 
                                contentType, 
                                season, 
                                episode
                            );
                            if (streamUrl) {
                                console.log(`✅ Success with ${serviceName} - redirecting to fallback stream`);
                                return res.redirect(streamUrl);
                            }
                        } catch (error) {
                            console.log(`❌ ${serviceName} failed: ${error.message}`);
                            continue;
                        }
                    } else if (serviceName === 'Premiumize') {
                        try {
                            const streamUrl = await service.getStreamUrl(
                                fallbackStream.magnetLink, 
                                'movie'
                            );
                            if (streamUrl) {
                                console.log(`✅ Success with ${serviceName} - redirecting to fallback stream`);
                                return res.redirect(streamUrl);
                            }
                        } catch (error) {
                            console.log(`❌ ${serviceName} failed: ${error.message}`);
                            continue;
                        }
                    } else {
                        const streamUrl = await getValidStreamingUrl(
                            service, 
                            fallbackStream.magnetLink, 
                            fallbackStream.hash,
                            contentType,
                            season,
                            episode
                        );
                        
                        if (streamUrl) {
                            console.log(`✅ Success with ${serviceName} - redirecting to fallback stream`);
                            return res.redirect(streamUrl);
                        }
                    }
                }
                
                console.log(`❌ All services failed for fallback ${i + 1}, trying next...`);
            }
        } else {
            console.log('\n⚠️ No cached fallback streams available');
        }

        // Step 3: If everything failed
        console.log('\n❌ All streams failed across all services');
        throw new Error('No cached stream available from any debrid service');

    } catch (error) {
        console.error('❌ Error processing magnet:', error.message);
        res.status(404).json({ 
            error: 'Stream not available', 
            details: error.message 
        });
    }
});

// Clean up old cache entries periodically (optional)
setInterval(() => {
    if (streamCache.size > 1000) { // Keep only last 1000 entries
        const entries = Array.from(streamCache.entries());
        const toKeep = entries.slice(-500); // Keep newest 500
        streamCache.clear();
        toKeep.forEach(([key, value]) => streamCache.set(key, value));
        console.log('🧹 Cleaned up stream cache');
    }
}, 60000); // Every minute

const port = process.env.PORT || 80;
app.listen(port, () => console.log(`\n🚀 Addon running at http://localhost:${port}`));
