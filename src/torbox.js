// torbox.js
import { ERROR } from './const.js';
import { BaseDebrid, findBestFile } from './base-debrid.js';

export class TorBox extends BaseDebrid {
    #apiUrl = 'https://api.torbox.app/v1/api';

    constructor(apiKey) {
        super(apiKey, 'tb');
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('tb=');
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log(`\n📡 TorBox: Checking ${hashes.length} hashes`);
            const results = {};

            // Process hashes in batches of 50
            const BATCH_SIZE = 50;
            for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
                const batchHashes = hashes.slice(i, i + BATCH_SIZE);
                console.log(`\nProcessing batch of ${batchHashes.length} hashes`);

                // Join hashes with commas for API request
                const hashParams = batchHashes.join(',');
                const url = `${this.#apiUrl}/torrents/checkcached?hash=${hashParams}&format=list&list_files=true`;

                console.log('Requesting URL:', url);

                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.getKey()}`
                    }
                });

                // Log raw response status
                console.log(`Response status: ${response.status} ${response.statusText}`);
                
                // Get the raw response text for debugging
                const responseText = await response.text();
                console.log('Raw response text:', responseText);
                
                // Try to parse the response
                let responseData;
                try {
                    responseData = JSON.parse(responseText);
                    // Log the full response structure for debugging
                    console.log('Parsed response data:', JSON.stringify(responseData, null, 2));
                } catch (error) {
                    console.error('Failed to parse response:', error);
                    console.log('Invalid JSON response:', responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''));
                    continue;
                }

                if (!response.ok) {
                    if (responseData?.error === 'Invalid API key') {
                        throw new Error(ERROR.INVALID_API_KEY);
                    }
                    console.error('Error checking batch:', responseData);
                    continue;
                }

                // Debug: Log the structure of the response
                console.log('Response success:', responseData.success);
                if (responseData.data) {
                    console.log('Data length:', Array.isArray(responseData.data) ? responseData.data.length : 'not an array');
                    if (Array.isArray(responseData.data) && responseData.data.length > 0) {
                        // Log sample of first item
                        console.log('First item sample:', JSON.stringify(responseData.data[0], null, 2));
                    }
                }

                if (responseData.success && Array.isArray(responseData.data)) {
                    // Process each torrent in the response
                    responseData.data.forEach(torrent => {
                        if (torrent && torrent.hash) {
                            console.log('Found cached torrent with hash:', torrent.hash);
                            const hash = torrent.hash.toLowerCase();
                            results[hash] = {
                                cached: true,
                                files: torrent.files || [],
                                name: torrent.name || '',
                                size: torrent.size || 0,
                                torrentId: torrent.id,
                                service: 'TorBox' // Mark as TorBox service
                            };
                        }
                    });
                } else {
                    console.log('No cached torrents found in this batch or unexpected response format');
                }

                // Set uncached status for hashes not in response
                batchHashes.forEach(hash => {
                    const hashLower = hash.toLowerCase();
                    if (!results[hashLower]) {
                        results[hashLower] = {
                            cached: false,
                            files: [],
                            service: 'TorBox' // Still mark service even if uncached
                        };
                    }
                });

                if (i + BATCH_SIZE < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            const cachedCount = Object.values(results).filter(r => r.cached).length;
            console.log(`\nTorBox found ${cachedCount} cached torrents out of ${hashes.length}`);

            // Print a sample of results for debugging
            const resultsSample = Object.entries(results).slice(0, 3);
            console.log('Sample of results:', JSON.stringify(resultsSample, null, 2));

            return results;

        } catch (error) {
            console.error('Cache check failed:', error);
            return {};
        }
    }

    async getStreamUrl(magnetLink) {
        try {
            console.log('\n📥 Using TorBox to process magnet:', magnetLink.substring(0, 100) + '...');
            
            // Extract info hash from magnet link
            const hash = magnetLink.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
            if (!hash) {
                throw new Error('Invalid magnet link');
            }

            console.log('Checking existing torrents...');

            // First check if torrent already exists
            const listResponse = await fetch(
                `${this.#apiUrl}/torrents/mylist?bypass_cache=true`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.getKey()}`
                    }
                }
            );

            // Log raw response for debugging
            const listResponseText = await listResponse.text();
            console.log('Raw mylist response:', listResponseText);
            
            let listData;
            try {
                listData = JSON.parse(listResponseText);
                console.log('Parsed mylist data:', JSON.stringify(listData, null, 2));
            } catch (error) {
                console.error('Failed to parse mylist response:', error);
                throw new Error('Invalid response from TorBox API');
            }

            let torrentId;

            // Check if torrent already exists
            if (listData.success && Array.isArray(listData.data)) {
                const existingTorrent = listData.data.find(t => t.hash.toLowerCase() === hash);
                if (existingTorrent) {
                    console.log('Found existing torrent:', existingTorrent.id);
                    torrentId = existingTorrent.id;
                }
            }

            // If torrent doesn't exist, create it
            if (!torrentId) {
                console.log('Creating new torrent...');

                const formData = new FormData();
                formData.append('magnet', `magnet:?xt=urn:btih:${hash}`);

                const createResponse = await fetch(
                    `${this.#apiUrl}/torrents/createtorrent`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.getKey()}`
                        },
                        body: formData
                    }
                );

                const createResponseText = await createResponse.text();
                console.log('Raw create response:', createResponseText);
                
                let createData;
                try {
                    createData = JSON.parse(createResponseText);
                    console.log('Parsed create data:', JSON.stringify(createData, null, 2));
                } catch (error) {
                    console.error('Failed to parse create response:', error);
                    throw new Error('Invalid response from TorBox API');
                }

                if (!createResponse.ok || !createData.success || !createData.data?.torrent_id) {
                    throw new Error(`Failed to create torrent: ${createData.error || createData.detail || 'Unknown error'}`);
                }

                torrentId = createData.data.torrent_id;
            }

            // Get file list to find best file
            const filesResponse = await fetch(
                `${this.#apiUrl}/torrents/checkcached?hash=${hash}&format=list&list_files=true`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.getKey()}`
                    }
                }
            );

            const filesResponseText = await filesResponse.text();
            console.log('Raw files response:', filesResponseText);
            
            let filesData;
            try {
                filesData = JSON.parse(filesResponseText);
                console.log('Parsed files data:', JSON.stringify(filesData, null, 2));
            } catch (error) {
                console.error('Failed to parse files response:', error);
                throw new Error('Invalid response from TorBox API');
            }

            if (!filesResponse.ok || !filesData.success || !filesData.data?.[0]?.files) {
                throw new Error('Failed to get file list');
            }

            const files = filesData.data[0].files.map((file, index) => ({
                id: index,  // Use index as file ID
                name: file.name.split('/')[1] || file.name,  // Remove folder prefix
                size: file.size,
                path: file.name
            }));

            // Find best file
            const mediaInfo = this.extractMediaInfo(magnetLink);
            console.log('Media info:', mediaInfo);
            const bestFile = findBestFile(files, mediaInfo.type);

            if (!bestFile) {
                throw new Error('No suitable video file found');
            }

            console.log('Selected file:', bestFile.name);

            // Get download link
            const dlUrl = `${this.#apiUrl}/torrents/requestdl?token=${this.getKey()}&torrent_id=${torrentId}&file_id=${bestFile.id}&zip=false`;
            console.log('Requesting download URL:', dlUrl);

            const dlResponse = await fetch(dlUrl, {
                method: 'GET'
            });

            const dlResponseText = await dlResponse.text();
            console.log('Raw download response:', dlResponseText);
            
            let dlData;
            try {
                dlData = JSON.parse(dlResponseText);
                console.log('Parsed download data:', JSON.stringify(dlData, null, 2));
            } catch (error) {
                console.error('Failed to parse download response:', error);
                throw new Error('Invalid response from TorBox API');
            }

            if (!dlResponse.ok || !dlData.success || !dlData.data) {
                throw new Error(`Failed to get download URL: ${dlData.error || dlData.detail || 'Unknown error'}`);
            }

            return dlData.data;

        } catch (error) {
            console.error('❌ Failed to get stream URL:', error);
            throw error;
        }
    }
}