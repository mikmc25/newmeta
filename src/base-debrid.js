// base-debrid.js
import { VIDEO_EXTENSIONS } from './const.js';

export function findBestFile(files, mediaType = 'movie', mediaInfo = null) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        console.log('No files available to select from');
        return null;
    }

    console.log(`Finding best file from ${files.length} files`);
    console.log('Media type:', mediaType);
    if (mediaInfo) console.log('Media info:', mediaInfo);

    // Filter for video files first
    const videoFiles = files.filter(file => {
        const filename = (file.path || file.name || '').toLowerCase();
        return VIDEO_EXTENSIONS.some(ext => filename.endsWith(ext));
    });

    if (videoFiles.length === 0) {
        console.log('No video files found');
        return null;
    }

    console.log(`Found ${videoFiles.length} video files`);

    // Filter out unwanted files
    const mainFiles = videoFiles.filter(file => {
        const filename = (file.path || file.name || '').toLowerCase();
        return !filename.includes('sample') &&
               !filename.includes('trailer') &&
               !filename.includes('extra') &&
               !filename.includes('behind') &&
               !filename.includes('featurette') &&
               !filename.includes('bonus');
    });

    if (mediaType === 'series' && mediaInfo?.season != null && mediaInfo?.episode != null) {
        console.log(`Looking for S${mediaInfo.season}E${mediaInfo.episode}`);
        
        // Try different episode naming patterns
        const matchingFile = mainFiles.find(file => {
            const filename = (file.path || file.name || '').toLowerCase();
            
            // Different episode number formats
            const patterns = [
                new RegExp(`s0?${mediaInfo.season}e0?${mediaInfo.episode}\\b`, 'i'),
                new RegExp(`\\b${mediaInfo.season}x0?${mediaInfo.episode}\\b`, 'i'),
                new RegExp(`season[. ]?${mediaInfo.season}[. ]?episode[. ]?${mediaInfo.episode}\\b`, 'i'),
                new RegExp(`\\b0?${mediaInfo.season}0?${mediaInfo.episode}\\b`), // For 101, 102 format
                new RegExp(`e0?${mediaInfo.episode}\\b`, 'i') // For folders already in correct season
            ];

            const isMatch = patterns.some(pattern => pattern.test(filename));
            if (isMatch) {
                console.log('Found matching episode:', filename);
            }
            return isMatch;
        });

        if (matchingFile) {
            console.log('Selected episode:', matchingFile.path || matchingFile.name);
            console.log('Size:', Math.round((matchingFile.size || matchingFile.length) / (1024 * 1024)), 'MB');
            return matchingFile;
        } else {
            console.log('No matching episode found');
        }
    }

    // For movies or if no specific episode match found, sort by size
    mainFiles.sort((a, b) => {
        const sizeA = a.size || a.length || 0;
        const sizeB = b.size || b.length || 0;
        return sizeB - sizeA;
    });

    // For movies, prefer files in root or 'movie' directory
    if (mediaType === 'movie' && mainFiles.length > 1) {
        const bestFile = mainFiles.find(file => {
            const path = (file.path || file.name || '').toLowerCase();
            const parts = path.split('/');
            return parts.length <= 2 || // Root or single subfolder
                   parts.some(part => part.includes('movie'));
        }) || mainFiles[0]; // Fallback to largest if no good path match

        console.log('Selected movie file:', bestFile.path || bestFile.name);
        console.log('Size:', Math.round((bestFile.size || bestFile.length) / (1024 * 1024)), 'MB');
        return bestFile;
    }

    if (mainFiles.length > 0) {
        const selectedFile = mainFiles[0];
        console.log('Selected file:', selectedFile.path || selectedFile.name);
        console.log('Size:', Math.round((selectedFile.size || selectedFile.length) / (1024 * 1024)), 'MB');
        return selectedFile;
    }

    return null;
}

export class BaseDebrid {
    #apiKey;
    
    constructor(apiKey, prefix) {
        this.#apiKey = apiKey.replace(`${prefix}=`, '');
    }

    getKey() {
        return this.#apiKey;
    }

    extractMediaInfo(magnetLink) {
        try {
            const decodedName = decodeURIComponent(magnetLink.match(/dn=([^&]+)/)?.[1] || '');
            console.log('Decoded magnet name:', decodedName);
    
            // Check if it's a series by looking for episode patterns
            const seasonEpMatch = decodedName.match(/S(\d{1,2})(?:E|x)(\d{1,2})/i) ||
                                decodedName.match(/Season[. ](\d{1,2})[. ]Episode[. ](\d{1,2})/i);
    
            if (seasonEpMatch) {
                const season = parseInt(seasonEpMatch[1]);
                const episode = parseInt(seasonEpMatch[2]);
                console.log(`Detected TV series - Season ${season}, Episode ${episode}`);
                return {
                    type: 'series',
                    season: season,
                    episode: episode
                };
            }
            
            // Look for season/episode in path structure
            if (decodedName.includes('/')) {
                const parts = decodedName.split('/');
                const seasonMatch = parts.find(p => p.match(/Season[. ]?\d+/i));
                if (seasonMatch) {
                    const season = parseInt(seasonMatch.match(/\d+/)[0]);
                    // Look for episode number in filename
                    const lastPart = parts[parts.length - 1];
                    const episodeMatch = lastPart.match(/(?:E|Episode[. ]?)(\d+)/i);
                    if (episodeMatch) {
                        const episode = parseInt(episodeMatch[1]);
                        return {
                            type: 'series',
                            season: season,
                            episode: episode
                        };
                    }
                }
            }
            
            // Look for other series indicators
            if (decodedName.match(/Season \d+|Complete Series|TV Series|Episodes?/i)) {
                return { type: 'series' };
            }
            
            return { type: 'movie' };
        } catch (error) {
            console.error('Error extracting media info:', error);
            return { type: 'movie' };
        }
    }
}