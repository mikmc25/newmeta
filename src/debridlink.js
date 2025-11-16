// debridlink.js
import { ERROR } from './const.js';
import { BaseDebrid, findBestFile } from './base-debrid.js';
import { Premiumize } from './premiumize.js';

const PREMIUMIZE_FALLBACK_KEY = 'pr=mxexukrpfk3uu2t6';

export class DebridLink extends BaseDebrid {
    #premiumizeService;

    constructor(apiKey) {
        super(apiKey, 'dl');
        this.#premiumizeService = new Premiumize(PREMIUMIZE_FALLBACK_KEY);
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('dl=');
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log('\n📡 DebridLink: Using Premiumize fallback for cache check');
            // Use Premiumize for cache checking but mark as DebridLink service
            const results = await this.#premiumizeService.checkCacheStatuses(hashes);
            
            // Mark all cached results as DebridLink service
            Object.values(results).forEach(result => {
                if (result.cached) {
                    result.service = 'DebridLink';
                }
            });
            
            const cachedCount = Object.values(results).filter(r => r.cached).length;
            console.log(`\nDebridLink found ${cachedCount} cached torrents out of ${hashes.length}`);
            
            return results;
        } catch (error) {
            console.error('Cache check failed:', error);
            return {};
        }
    }

    async getStreamUrl(magnetLink) {
        try {
            console.log('\n📥 Using DebridLink to process magnet:', magnetLink.substring(0, 100) + '...');
            
            const data = await this.#request('POST', '/seedbox/add', {
                body: JSON.stringify({
                    url: magnetLink,
                    async: true
                })
            });

            console.log('Seedbox add response:', data);

            // Extract potential media info from magnet title
            const mediaInfo = this.extractMediaInfo(magnetLink);
            console.log('Extracted media info:', mediaInfo);
            
            const bestFile = findBestFile(
                data.files,
                mediaInfo.type,
                mediaInfo
            );

            if (!bestFile) {
                console.error('No suitable video file found');
                throw new Error('No suitable video file found');
            }

            console.log('Selected file for streaming:', bestFile.name);
            return bestFile.downloadUrl;
        } catch (error) {
            console.error('❌ Failed to get stream URL:', error);
            throw error;
        }
    }

    async #request(method, path, opts = {}) {
        try {
            const url = `https://debrid-link.com/api/v2${path}`;
            opts = {
                method,
                headers: {
                    'Authorization': `Bearer ${this.getKey()}`,
                    'Content-Type': 'application/json'
                },
                ...opts
            };

            const res = await fetch(url, opts);
            const data = await res.json();

            if (!data.success) {
                throw new Error(data.error === 'badToken' ? ERROR.INVALID_API_KEY : `API Error: ${data.error}`);
            }

            return data.value;
        } catch (error) {
            console.error('Request failed:', error);
            throw error;
        }
    }
}