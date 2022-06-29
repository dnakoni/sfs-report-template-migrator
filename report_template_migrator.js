/*
 * Copyright (c) 2022, Daniel Nakonieczny
 * All rights reserved.
 * date: June 28 2022
 * description: Contains the Service Report Template Migrator code
 */

const puppeteer = require('puppeteer');
const YAML = require('yaml')
const jsforce = require('jsforce');
const util = require('util');
const fs = require('fs');
require('dotenv').config();

var source_connection = new jsforce.Connection({
    loginUrl : process.env.SOURCE_ORG_LOGIN_URL
});

var target_connection = new jsforce.Connection({
    loginUrl : process.env.TARGET_ORG_LOGIN_URL
});

const customFieldIdRegex = /00N[a-zA-Z0-9]{12}/g;
const jsonLayoutParamRegex = /j_id0%3Af%3AjsonLayout[^&?]*?=[^&?]*/;
const imgTagRegex1 = /(?<=%3Cimg).*?(?=%2F%3E)/g;
const imgTagRegex2 = /(?<=%3Cimg).*?(?=%3C%2Fimg%3E)/g;
const emptyImgTag1 = '%3Cimg%2F%3E';
const emptyImgTag2 = '%3Cimg%3C%2Fimg%3E';
const writeFile = util.promisify(fs.appendFile);
const reportNamesFile = fs.readFileSync('./config.yml', 'utf8')
const yamlConfig = YAML.parse(reportNamesFile);
const reportNames = yamlConfig.reportNames;
const subtypesToMigrate = yamlConfig.reportSubtypesToMigrate;
const CREATE_REPORTS_IN_TARGET_ORG = yamlConfig.createReportsInTargetOrg;
const RUN_IN_BACKGROUND = yamlConfig.runInBackground;
const LOG_POST_DATA = yamlConfig.writePOSTDataToFile;
const ERROR_LOG_FILENAME = yamlConfig.errorLogFilename;
const WINDOW_WIDTH = yamlConfig.windowWidth
const WINDOW_HEIGHT = yamlConfig.windowHeight
const TIMEOUT_BETWEEN_ACTIONS = yamlConfig.timeoutBetweenActions;
const REPLACE_SOURCE_IMAGES = yamlConfig.removeSourceImages;
const IMAGE_REPLACEMENT_TEXT = yamlConfig.imageReplacementText;
const SUPPORTED_SUBTYPES = {
    "SA_WO": "Service Appointment for Work Order",
    "SA_WOLI": "Service Appointment for Work Order Line Item",
    "WO": "Work Order",
    "WOLI": "Work Order Line Item"
};

let sourceAccessToken;
let targetAccessToken;
let browser;
let incognitoContext;
let openedPages = [];
let reportNameToURLMapSource = {};
let reportNameToURLMapTarget = {};
let reportNameToJSON = {};
let reportNameToJSONReplaced = {};
let customObjectIdsToLookup = [];
let allSourceFieldIds = [];
let sourceObjectIdToNameMap = {};
let sourceObjectIdToSObject = {};
let sourceObjectIdMap = {};
let sourceFieldIdMap = {};
let api_name_list = [];
let keys_to_skip = [];

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

_throw = (stringError) => {
    writeFile(ERROR_LOG_FILENAME, stringError).then(err => {
        if (err)
            console.log(err)
        throw new Error(`\r\n${stringError}\r\n`);
    });
};

fs.writeFile(ERROR_LOG_FILENAME, '', { flag: 'wx' }, function (err) {});

(async () => {
    await source_connection.login(process.env.SOURCE_ORG_USERNAME, `${process.env.SOURCE_ORG_PASSWORD}${process.env.SOURCE_ORG_SECURITY_TOKEN}`, function(err, userInfo) {
        if (err) { return console.error(err); }
        sourceAccessToken = source_connection.accessToken;
    });

    await target_connection.login(process.env.TARGET_ORG_USERNAME, `${process.env.TARGET_ORG_PASSWORD}${process.env.TARGET_ORG_SECURITY_TOKEN}`, function(err, userInfo) {
        if (err) { return console.error(err); }
        targetAccessToken = target_connection.accessToken;
    });

    browser = await puppeteer.launch({
        headless: RUN_IN_BACKGROUND,
        args: [`--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`],
        defaultViewport: {
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT
        }
    });
    incognitoContext = await browser.createIncognitoBrowserContext();

    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await loginToSourceOrg();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await loginToTargetOrg();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    if (CREATE_REPORTS_IN_TARGET_ORG === true) {
        await createReportsInTargetOrg();
    }
    await grabSourceOrgReportLinks();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await grabSourceOrgReportJSON();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await cleanupTabs();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await extractSourceOrgCustomObjectsAndFields();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await matchSourceToTargetOrgCustomObjectAndFieldIds();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await replaceCustomFieldIds();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await grabTargetOrgReportLinks();
    await sleep(TIMEOUT_BETWEEN_ACTIONS);
    await deployReportTemplatesToTargetOrg();

    console.log('ALL DONE!');

    await browser.close();

    async function logErrors(messagesArray) {
        console.error('The following errors happened:');
        console.error(messagesArray);
        let formattedErrors = messagesArray.map(message => `${new Date().toLocaleString()} ${message}`);
        _throw(`${formattedErrors.join('\r\n')}\r\n`);
    }

    async function loginToSourceOrg() {
        await loginToOrg(process.env.SOURCE_ORG_LOGIN_URL, sourceAccessToken, false);
    }

    async function loginToTargetOrg() {
        await loginToOrg(process.env.TARGET_ORG_LOGIN_URL, targetAccessToken, true);
    }

    async function loginToOrg(loginUrl, accessToken, incognito) {
        if (!accessToken) {
            let message = 'Browser login failed. Please run this script again.';
            _throw(`${new Date().toLocaleString()} ${message}\r\n`);
        }

        let loginPage;

        if (incognito) { 
            loginPage = await incognitoContext.newPage();
        } else {
            loginPage = await browser.newPage();
        }

        await loginPage.goto(`${loginUrl}/secur/frontdoor.jsp?sid=${accessToken}`);
        await loginPage.waitForTimeout(TIMEOUT_BETWEEN_ACTIONS);

        const pageUrl = await loginPage.url();

        if (pageUrl.includes('ec=302')) {
            //sometimes the frontdoor.jsp login doesn't work and the script needs to be restarted
            let message = 'Browser login failed. Please run this script again.';
            _throw(`${new Date().toLocaleString()} ${message}\r\n`);
        }
        
    }

    async function cleanupTabs() {
        for (let p of openedPages) {
            p.close();
        }

        openedPages = [];
    }

    async function createReportsInTargetOrg() {
        for (let reportName of reportNames) {
            let newReportPage = await incognitoContext.newPage();
            await newReportPage.goto(`${process.env.TARGET_ORG_LOGIN_URL}/_ui/support/fieldservice/ui/ServiceReportTemplateClone/e?p1=${reportName}`, {waitUntil: 'networkidle0'});
            await newReportPage.click("input[name='save']");
            await sleep(TIMEOUT_BETWEEN_ACTIONS);
        }
    }

    async function grabSourceOrgReportLinks() {
        for (const reportName of reportNames) {
            let newReportPage = await browser.newPage();
            await newReportPage.goto(`${process.env.SOURCE_ORG_LOGIN_URL}/_ui/support/fieldservice/ui/ServiceReportTemplateLayouts`);
            const reportLink = await newReportPage.evaluate((name) =>  document.querySelector(`a[title$="${name}"]`).getAttribute("href"), reportName);
            reportNameToURLMapSource[reportName] = reportLink;
        }
    }

    async function grabSourceOrgReportJSON() {
        let requestsProcessed = [];

        for (let reportSubtype of Object.keys(SUPPORTED_SUBTYPES)) {
            if (subtypesToMigrate.includes(reportSubtype)) {
                await grabSourceReport(reportSubtype, SUPPORTED_SUBTYPES[reportSubtype], requestsProcessed);
            }
        }
    }

    async function grabSourceReport(subtypeName, subtypeLabel, requestsProcessed) {
        for (var currentReportName in reportNameToURLMapSource) {
            var reportVersionName = `${currentReportName}_${subtypeName}`;
            var url = reportNameToURLMapSource[currentReportName];

            let newReportPage = await browser.newPage();
            openedPages.push(newReportPage);
            
            await newReportPage.goto(`${process.env.SOURCE_ORG_LOGIN_URL}${url}`, {waitUntil: 'networkidle0'});
            await goToTemplateSubtype(newReportPage, subtypeLabel);

            await newReportPage.setRequestInterception(true);
    
            newReportPage.on('request', request => {
                const request_url = request.url();
                const request_post_data = request.postData();

                if (request_url.includes('/servicereport/serviceReportTemplateEditor.apexp') &&
                    request_post_data &&
                    request_post_data.includes('j_id0%3Af%3AjsonLayout') &&
                    requestsProcessed.includes(reportVersionName) == false) {

                    var regex = jsonLayoutParamRegex;
                    var matched = regex.exec(request_post_data);
                    reportNameToJSON[reportVersionName] = matched[0];

                    if (LOG_POST_DATA) {
                        let dataToWrite = decodeURIComponent(matched[0].replace('j_id0%3Af%3AjsonLayout=',''));
                        dataToWriteFormatted = JSON.stringify(JSON.parse(dataToWrite), null, 2);
                        
                        fs.writeFile(`${reportVersionName} source org POST data.txt`, dataToWriteFormatted, function (err) {
                            if (err) return console.log(err);
                        });
                    }

                    requestsProcessed.push(reportVersionName);

                    request.continue();
                } else {
                    request.continue();
                }
            
            });

            await clickQuickSave(newReportPage);
        }
    }

    async function extractSourceOrgCustomObjectsAndFields() {
        for (var currentReportName in reportNameToJSON) {
            var jsonString = reportNameToJSON[currentReportName];
            const array = [...jsonString.matchAll(customFieldIdRegex)];
            const results = array.flatMap(x => x[0]);
        
            for (const fieldId of results) {
                if (allSourceFieldIds.includes(fieldId) == false) {
                    allSourceFieldIds.push(fieldId);
                }
            }
        }

        for (const sourceFieldId of allSourceFieldIds) {
            await source_connection.tooling.query(`SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE Id = '${sourceFieldId}'`, function(err, res) {
                if (err) { return console.error(err); }
        
                if (res && res.records) {
                    console.log(res.records[0].DeveloperName);
                    api_name_list.push(res.records[0]);

                    if (res.records[0].TableEnumOrId.startsWith('01I') && customObjectIdsToLookup.includes(res.records[0].TableEnumOrId) == false) {
                        console.log('adding source TableEnumOrId: ' + res.records[0].TableEnumOrId);
                        customObjectIdsToLookup.push(res.records[0].TableEnumOrId);
                    }
                } else {
                    keys_to_skip.push(sourceFieldId);
                }
            });
        }

        console.log('customObjectIdsToLookup:');
        console.log(customObjectIdsToLookup);

        for (const customObjectId of customObjectIdsToLookup) {
            console.log('looking up custom object id ' + customObjectId);
            await source_connection.tooling.query(`SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id = '${customObjectId}'`, function(err, res) {
                if (err) { return console.error(err); }
        
                if (res && res.records) {
                    console.log(`custom object: ${res.records[0].DeveloperName}`);

                    sourceObjectIdToNameMap[customObjectId] = res.records[0];
                }
            });
        }
    }

    async function matchSourceToTargetOrgCustomObjectAndFieldIds() {
        let missingObjects = [];
        let missingFields = [];

        for (var sourceObjectId in sourceObjectIdToNameMap) {
            var customObject = sourceObjectIdToNameMap[sourceObjectId];

            if (customObject && customObject.DeveloperName) { 
                await target_connection.tooling.query(`SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE DeveloperName = '${customObject.DeveloperName}' AND NamespacePrefix = '${(customObject.NamespacePrefix == null ? '' : customObject.NamespacePrefix)}'`, function(err, res) {
                    if (err) { return console.error(err); }
            
                    if (res && res.records && res.records[0]) {
                        let record = res.records[0];
                        sourceObjectIdMap[customObject.Id] = record.Id;
                        sourceObjectIdToSObject[customObject.Id] = record;
                        console.log(`adding object source id: ${customObject.Id}, target id: ${record.Id}`);
                    } else {
                        let errorMessage = `custom object missing in target org: ${(customObject.NamespacePrefix == null ? '' : (customObject.NamespacePrefix+'__'))}${customObject.DeveloperName}__c`;
                        missingObjects.push(errorMessage);
                    }
                    
                });
            }
        }

        if (missingObjects.length) {
            logErrors(missingObjects);
        }

        for (const customField of api_name_list) {

            if (customField && customField.DeveloperName) { 
                let parentObjectName = customField.TableEnumOrId;

                if (customField.TableEnumOrId.startsWith('01I')) {
                    let parentObject = sourceObjectIdToSObject[customField.TableEnumOrId];
                    parentObjectName = `${(parentObject.NamespacePrefix == null ? '' : (parentObject.NamespacePrefix + '__'))}${parentObject.DeveloperName}`;
                    customField.TableEnumOrId = sourceObjectIdMap[customField.TableEnumOrId];
                }

                console.log('running CustomField query:');
                console.log(`SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE DeveloperName = '${customField.DeveloperName}' AND TableEnumOrId = '${customField.TableEnumOrId}' AND NamespacePrefix = '${(customField.NamespacePrefix == null ? '' : customField.NamespacePrefix)}'`);

                await target_connection.tooling.query(`SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE DeveloperName = '${customField.DeveloperName}' AND TableEnumOrId = '${customField.TableEnumOrId}' AND NamespacePrefix = '${(customField.NamespacePrefix == null ? '' : customField.NamespacePrefix)}'`, function(err, res) {
                    if (err) { return console.error(err); }
            
                    if (res && res.records && res.records[0]) {
                        let record = res.records[0];
                        //-- for whatever reason the service report templates only use 15 character IDs
                        sourceFieldIdMap[customField.Id.substring(0, 15)] = record.Id.substring(0, 15);
                    } else {
                        let errorMessage = `custom field ${(customField.NamespacePrefix == null ? '' : (customField.NamespacePrefix+'__'))}${customField.DeveloperName}__c on object ${parentObjectName}__c is missing in target org`;
                        missingFields.push(errorMessage);
                    }
                    
                });
            }
        }

        if (missingFields.length) {
            logErrors(missingFields);
        }
    }

    async function replaceCustomFieldIds() {

        for (var currentReportName in reportNameToJSON) {
            var jsonString = reportNameToJSON[currentReportName];
            const array = [...jsonString.matchAll(customFieldIdRegex)];
            const results = array.flatMap(x => x[0]);
            console.log(`Custom field Ids found in source org for ${currentReportName}:`);
            console.log(results);
        
            for (const fieldId of results) {
                if (sourceFieldIdMap[fieldId]) {
                    var targetOrgFieldId = sourceFieldIdMap[fieldId];
                    console.log(`Target org Id of source custom field ${fieldId}: ${targetOrgFieldId}`);
                    jsonString = jsonString.replaceAll(fieldId, targetOrgFieldId);
                }
            }

            if (REPLACE_SOURCE_IMAGES) { 
                jsonString = jsonString.replaceAll(imgTagRegex1, '');
                jsonString = jsonString.replaceAll(imgTagRegex2, '');
                jsonString = jsonString.replaceAll(emptyImgTag1, IMAGE_REPLACEMENT_TEXT);
                jsonString = jsonString.replaceAll(emptyImgTag2, IMAGE_REPLACEMENT_TEXT);
            }

            reportNameToJSONReplaced[currentReportName] = jsonString;
        }
    }

    async function grabTargetOrgReportLinks() {
        for (const reportName of reportNames) {
            let newReportPage = await incognitoContext.newPage();
            await newReportPage.goto(`${process.env.TARGET_ORG_LOGIN_URL}/_ui/support/fieldservice/ui/ServiceReportTemplateLayouts`);
            const reportLink = await newReportPage.evaluate((name) => document.querySelector(`a[title$="${name}"]`).getAttribute("href"), reportName);
            reportNameToURLMapTarget[reportName] = reportLink;
        }
    }

    async function deployReportTemplatesToTargetOrg() {
        let requestsProcessed = [];

        for (let reportSubtype of Object.keys(SUPPORTED_SUBTYPES)) {
            if (subtypesToMigrate.includes(reportSubtype)) {
                await deployReportTemplate(reportSubtype, SUPPORTED_SUBTYPES[reportSubtype], requestsProcessed);
            }
        }
    }

    async function deployReportTemplate(subtypeName, subtypeLabel, requestsProcessed) {
        for (var currentReportName in reportNameToURLMapTarget) {
            var reportVersionName = `${currentReportName}_${subtypeName}`;
            var url = reportNameToURLMapTarget[currentReportName];

            let newReportPage = await incognitoContext.newPage();

            openedPages.push(newReportPage);
            
            await newReportPage.goto(`${process.env.TARGET_ORG_LOGIN_URL}${url}`, {waitUntil: 'networkidle0'});
            await goToTemplateSubtype(newReportPage, subtypeLabel);

            await newReportPage.setRequestInterception(true);

            newReportPage.on('request', request => {
                const request_url = request.url();
                const request_post_data = request.postData();

                if (request_url.includes('/servicereport/serviceReportTemplateEditor.apexp') &&
                    request_post_data &&
                    request_post_data.includes('j_id0%3Af%3AjsonLayout')
                    ) {

                    var regex = jsonLayoutParamRegex;
                    var matchedString = regex.exec(request_post_data)[0];

                    if (reportNameToJSON[reportVersionName]) {
                        request.continue({
                            postData: request_post_data.replace(matchedString, reportNameToJSONReplaced[reportVersionName])
                        });
                        
                        if (LOG_POST_DATA && requestsProcessed.includes(reportVersionName) == false) {
                            let dataToWrite = decodeURIComponent((reportNameToJSONReplaced[reportVersionName].replace('j_id0%3Af%3AjsonLayout=','')));
                            dataToWriteFormatted = JSON.stringify(JSON.parse(dataToWrite), null, 2);

                            fs.writeFile(`${reportVersionName} target org POST data.txt`, dataToWriteFormatted, function (err) {
                                if (err) return console.log(err);
                            });
                        }

                        requestsProcessed.push(reportVersionName);
                    } else {
                        request.continue();
                    }
                } else {
                    request.continue();
                }
            
            });

            await clickQuickSave(newReportPage);
        }
    }

    async function clickQuickSave(reportPage) {
        const [button] = await reportPage.$x("//button[contains(., 'Quick Save')]");
        if (button) {
            await button.click();
            await reportPage.waitForTimeout(TIMEOUT_BETWEEN_ACTIONS);
        }

        await sleep(TIMEOUT_BETWEEN_ACTIONS);
    }

    async function goToTemplateSubtype(reportPage, subtypeLabel) {
        await reportPage.waitForTimeout(TIMEOUT_BETWEEN_ACTIONS);
        let optionValue = await reportPage.$$eval('select[name$="childLayoutPicklist:templateList"] option', (options, subtypeLabel) => options.find(o => o.innerText === subtypeLabel)?.value, subtypeLabel);
        await reportPage.select('select[name$="childLayoutPicklist:templateList"]', optionValue);
        await reportPage.waitForTimeout(TIMEOUT_BETWEEN_ACTIONS);
    }
})();