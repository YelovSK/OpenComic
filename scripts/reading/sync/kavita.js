const http = require('node:http'),
	https = require('node:https');

// Not the renderer's fetch: the app runs from file:// and Kavita doesn't answer CORS preflights for other origins
function send(url, method = 'GET', headers = {}, body = undefined)
{
	return new Promise(function(resolve, reject) {

		const request = (url.startsWith('https:') ? https : http).request(url, {method: method, headers: headers, timeout: 3000}, function(response) {

			let data = '';

			response.setEncoding('utf8');
			response.on('data', (chunk) => data += chunk);
			response.on('end', () => resolve({status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, json: () => JSON.parse(data)}));

		});

		request.on('timeout', () => request.destroy(new Error('Kavita request timed out: '+url)));
		request.on('error', reject);
		request.end(body);

	});
}

const downloadRegex =/^(.*)\/api\/opds\/([^\/]+)\/series\/([0-9]+)\/volume\/([0-9]+)\/chapter\/([0-9]+)\/download\//;

function match(url)
{
	const match = url.match(downloadRegex);
	if(!match) return false;

	return {
		server: match[1],
		apiKey: match[2],
		seriesId: +match[3],
		volumeId: +match[4],
		chapterId: +match[5],
	};
}

const tokens = new Map();

function token(book, refresh = false)
{
	const key = book.server+'|'+book.apiKey;

	if(refresh || !tokens.has(key))
	{
		const promise = (async function() {

			const response = await send(book.server+'/api/plugin/authenticate?apiKey='+encodeURIComponent(book.apiKey)+'&pluginName=OpenComic', 'POST');
			if(!response.ok) throw new Error('Kavita authentication failed: '+response.status);

			return response.json().token;

		})();

		promise.catch(function() {

			if(tokens.get(key) === promise)
				tokens.delete(key);

		});

		tokens.set(key, promise);
	}

	return tokens.get(key);
}

async function request(book, path, body = undefined, retry = true)
{
	const response = await send(book.server+path, body ? 'POST' : 'GET', {
		'Authorization': 'Bearer '+(await token(book, !retry)),
		'Content-Type': 'application/json',
		'Accept': 'application/json',
	}, body ? JSON.stringify(body) : undefined);

	if(response.status === 401 && retry)
		return request(book, path, body, false);

	if(!response.ok)
		throw new Error('Kavita '+path+' failed: '+response.status);

	return response;
}

const chapters = new Map();

async function chapterInfo(book)
{
	const key = book.server+'|'+book.chapterId;

	if(!chapters.has(key))
	{
		const response = await request(book, '/api/reader/chapter-info?chapterId='+book.chapterId);
		chapters.set(key, await response.json());
	}

	return chapters.get(key);
}

// Kavita's pageNum is the 0-based index of the current page, and the chapter counts as read once it reaches the page count.
// OpenComic counts a book as read when the last page is open, so both ends map to the last page.
async function get(book)
{
	const [info, progress] = await Promise.all([
		chapterInfo(book),
		request(book, '/api/reader/get-progress?chapterId='+book.chapterId).then((response) => response.json()),
	]);

	if(!progress.seriesId)
		return false;

	const updated = progress.lastModifiedUtc ? Date.parse(/Z|[+-][0-9:]+$/.test(progress.lastModifiedUtc) ? progress.lastModifiedUtc : progress.lastModifiedUtc+'Z') : 0;

	return {
		page: Math.min(progress.pageNum + 1, info.pages),
		updated: updated,
	};
}

async function set(book, page, pages)
{
	const info = await chapterInfo(book);

	await request(book, '/api/reader/progress', {
		libraryId: info.libraryId,
		seriesId: book.seriesId,
		volumeId: book.volumeId,
		chapterId: book.chapterId,
		pageNum: (page > 0 && page >= pages) ? info.pages : Math.max(page - 1, 0),
	});
}

// Same as .NET's Uri.EscapeDataString, which Kavita uses for the file name in OPDS download links
function escapeDataString(string)
{
	return encodeURIComponent(string).replace(/[!'()*]/g, (char) => '%'+char.charCodeAt(0).toString(16).toUpperCase());
}

async function neighbour(book, direction)
{
	const response = await request(book, '/api/reader/'+(direction > 0 ? 'next' : 'prev')+'-chapter?seriesId='+book.seriesId+'&volumeId='+book.volumeId+'&currentChapterId='+book.chapterId);
	const chapterId = response.json();

	if(chapterId < 0)
		return false;

	const chapter = (await request(book, '/api/chapter?chapterId='+chapterId)).json();
	const fileName = chapter.files[0].filePath.split(/[\/\\]/).pop();

	return {
		url: book.server+'/api/opds/'+book.apiKey+'/series/'+book.seriesId+'/volume/'+chapter.volumeId+'/chapter/'+chapterId+'/download/'+escapeDataString(fileName),
		title: fileName.replace(/\.[^\.]*$/, ''),
	};
}

module.exports = {
	match,
	get,
	set,
	neighbour,
};
