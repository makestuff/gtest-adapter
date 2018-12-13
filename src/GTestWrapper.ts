import { DebugConfiguration,workspace, debug, window, commands, ConfigurationTarget, OutputChannel, tasks, TaskGroup, TaskEndEvent } from 'vscode';
import { ChildProcess, spawn, execSync } from 'child_process';
import { tmpdir } from 'os';
import { Controller } from './Controller';
import { existsSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { Status, TestNode } from './TestNode';
import { RunStatus } from './RunStatus';
import { JsonEntry } from './JsonOutputs';
import { TestLocation } from './TestLocation';

function getPlatform(): string {
    if (process.platform === 'win32')
        return 'windows';
    else if (process.platform === 'darwin')
        return 'osx';
    else return 'linux';
}
 function appExistsSync(app: string) : boolean
{
    let exists = existsSync(app);
    if (!exists)
    {
        const platform = getPlatform();
        const extensions_exist = (extensions : string[]) => {
            for (const ext of extensions)
            {
                if (!app.endsWith(ext))
                {
                    if (existsSync(app + ext)) return true;
                }
            }
            return false;
        }
         if (platform === "windows")
        {
            return extensions_exist(['.exe']);
        }
    }
    return exists;
}

export class GTestWrapper {
    private _passedTests: number;
    private _failedTests: number;
    private _runner: ChildProcess | undefined;
    private _outputChannel: OutputChannel;

    constructor(private controller: Controller) {
        this._passedTests = 0;
        this._failedTests = 0;
        this._outputChannel = window.createOutputChannel('GoogleTest output');
    }


    public runAllTests(testPathResolveRoots: Map<string, string | undefined>) {
        var configs = this.getTestsConfig();
        if (configs) {
            configs.forEach(config => this.runTestByName(config.name, '*', testPathResolveRoots.get(config.name)));
        }
    }
    
    public runTestByName(configName: string, testName: string, testPathResolveRoot: string | undefined) {
        this.stopRun();
        this._passedTests = 0;
        this._failedTests = 0;
        if (workspace.getConfiguration().get<boolean>("gtest-adapter.showRunOutput")) {
            this._outputChannel.show();
        }
        if (workspace.getConfiguration().get<boolean>("gtest-adapter.clearRunOutput")) {
            this._outputChannel.clear();
        }
        setTimeout(() => this.realRunTestByName(configName, testName, testPathResolveRoot), 500); //Adding this timeout allows time to clear tree icons
    }

    private realRunTestByName(configName: string, testName: string, testPathResolveRoot: string | undefined) {
        const args: ReadonlyArray<string> = ['--gtest_filter=' + testName];
        const testConfigs = this.getTestsConfig();
        if (!testConfigs)
            return;
        const config = testConfigs.find(testConfig => testConfig.name == configName);
        if (!config)
            return;
        this._runner = spawn(config.program, args, { detached: true, cwd: config.cwd, env: config.env });
        let isRun = false;
        let addedNewLine = false;
        this._runner.stdout.on('data', data => {
            var dataStr = '';
            if (typeof (data) == 'string') {
                dataStr = data as string;
            } else {
                dataStr = (data as Buffer).toString();
            }
            var lines = dataStr.split(/[\r\n]+/g);
            lines.forEach(line => {
                if (line != '') {
                    if (line.startsWith('[       OK ]') && line.endsWith(')')) {
                        this.controller.setTestStatus(GTestWrapper.getTestName(line), Status.Passed);
                        if (!this._passedTests)
                            this._passedTests = 0;
                        this._passedTests++;
                    } else if (line.startsWith('[  FAILED  ]')  && line.endsWith(')')) {
                        this.controller.setTestStatus(GTestWrapper.getTestName(line), Status.Failed);
                        this._failedTests++;
                    }
                    if (isRun) {
                        var match = line.match(regexPathAndLine);
                       if (match) {
                           var pathLength = match[0].lastIndexOf('(');
                           var path = match[0].substring(0, pathLength);
                           var lineNo = match[0].substring(pathLength + 1, match[0].length - 1);
                           var remainder = line.substring(match[0].length);
                           if (testPathResolveRoot) {
                               path = resolve(testPathResolveRoot, path);
                           }
                           line = path + ':' + lineNo + remainder;
                       }
                    }
                    isRun = line.startsWith('[ RUN      ]');
                    this._outputChannel.appendLine(line);
                    if (!addedNewLine && line.startsWith("[----------]")) {
                        this._outputChannel.appendLine('');
                        addedNewLine = true;
                    } else {
                        addedNewLine = false;
                    }
                }
            });
            this.controller.refreshDisplay(RunStatus.Running, this._passedTests, this._failedTests + this._passedTests);
        });
        this._runner.on('exit', code => {
            this.controller.refreshDisplay(RunStatus.RunCompleted, this._passedTests, this._failedTests + this._passedTests);
        });
        this.controller.refreshDisplay(RunStatus.Running, this._passedTests, this._failedTests + this._passedTests);
    }

    public debugTest(configName: string, testName: string) {
        var debugConfigs = this.getDebugConfig();
        if (debugConfigs) {
            const debugConfig = debugConfigs.find(dc => dc.name == configName);
            if (workspace.workspaceFolders && debugConfig) {
                debugConfig.args = ['--gtest_filter=' + testName];
                debug.startDebugging(workspace.workspaceFolders[0], debugConfig);
                commands.executeCommand('workbench.view.debug');
            }
        }
    }

    public stopRun() {
        if (this._runner)
            this._runner.kill();
        this.controller.refreshDisplay(RunStatus.RunCompleted, this._passedTests, this._failedTests + this._passedTests);
    }

    public reload() {
        this._passedTests = 0;
        this._failedTests = 0;
    }

    public switchConfig() {
        const debugConfigs = workspace.getConfiguration("launch").get("configurations") as Array<CppDebugConfig>;
        if (debugConfigs.length == 0) {
            window.showErrorMessage(`You first need to define a debug configuration, for your tests`);
        } else {
            let options = debugConfigs.map(s => s.name);
            window.showQuickPick(options, {canPickMany: true})
                .then(s => {
                    if (s) {
                        workspace.getConfiguration().update("gtest-adapter.debugConfig", s, ConfigurationTarget.Workspace);
                        this.controller.reloadAll();
                    }
                });
        }
    }   

    private getDebugConfig(): CppDebugConfig[] | undefined {
        let debugConfigNames = workspace.getConfiguration("gtest-adapter").get<string | string[]>("debugConfig");
        if (!debugConfigNames) {
            return undefined;
        }
        if (! Array.isArray(debugConfigNames)) {
            debugConfigNames = [debugConfigNames];
        }
        const namesSet = new Set(debugConfigNames);
        const debugConfigs = workspace.getConfiguration("launch", null).get("configurations") as Array<CppDebugConfig>;
        return debugConfigs.filter(config => namesSet.has(config.name));
    }

    private getDebugProgram(debugConfig: CppDebugConfig): string | undefined {
        let program = debugConfig.program;
        const platform = getPlatform();
        if (debugConfig[platform] && debugConfig[platform].program)
            program = debugConfig[platform].program;
        return program;
    }

    private runBuildTask()
    {
        tasks.fetchTasks().then(task_list => {
            const build_task_list = task_list.filter(task => task.group === TaskGroup.Build);
            const build_task_names = build_task_list.map(task => task.name);
            if (build_task_names.length > 0)
            {
                window.showQuickPick(build_task_names).then(build_task_name => {
                    if (build_task_name)
                    {
                        const build_task = build_task_list.find(task => task.name == build_task_name);
                        if (build_task)
                        {
                            const task_end_event = (event: TaskEndEvent) =>
                            {
                                if (event.execution.task.name === build_task_name)
                                {
                                    sub.dispose();
                                    this.controller.reloadAll();
                                }
                            };
                            const sub = tasks.onDidEndTask(task_end_event);
                            tasks.executeTask(build_task);
                        }
                        else window.showErrorMessage(`Failed to execute "${build_task_name}" task.`);
                    }
                });                             
            }
            else window.showErrorMessage('No build tasks available.');
        });
    }

    private getTestsConfig(): TestConfig[] | undefined {
        var debugConfig = this.getDebugConfig();
        if (!debugConfig) {
            const debugConfigs = workspace.getConfiguration("launch").get("configurations") as Array<CppDebugConfig>;
            if (debugConfigs.length == 0) {
                window.showErrorMessage(`You first need to define a debug configuration, for your tests`);
            } else {
                var options: string[] = [];
                debugConfigs.forEach(s => options.push(s.name));
                window.showQuickPick(options, {placeHolder: "You first need to select a debug configuration, for your tests"})
                    .then(s => {
                        if (s) {
                            workspace.getConfiguration().update("gtest-adapter.debugConfig", [s], ConfigurationTarget.Workspace);
                            this.controller.reloadAll();
                        }
                    });
            }
        }
        if (!debugConfig) {
            return undefined;
        }

        var workspaceFolder = this.getWorkspaceFolder();
        debugConfig = debugConfig.filter(dc => this.isValidDebugConfig(workspaceFolder, dc));
        var env = process.env;
        var result = debugConfig.map(dc => {
            if (dc.environment) {
                env = JSON.parse(JSON.stringify(process.env));
                dc.environment.forEach(entry => {
                    if (entry.name != undefined && entry.value != undefined) {
                        env[entry.name] = entry.value;
                    }
                });
            }
            var cwd = dc.cwd;
            if (!cwd) {
                cwd = "${workspaceFolder}";
            }
            cwd = this.expandEnv(cwd, workspaceFolder);
            const testApp = resolve(workspaceFolder, this.expandEnv(this.getDebugProgram(dc) as string, workspaceFolder));
            return new TestConfig(dc.name, testApp, env, cwd);    
        });
        return result;
    }

    private isValidDebugConfig(workspaceFolder: string, debugConfig: CppDebugConfig) {
        var program = this.getDebugProgram(debugConfig);
        if (!program)
            return false;
        program = this.expandEnv(program, workspaceFolder);
        return appExistsSync(resolve(workspaceFolder, program));
    }

    private expandEnv(path: string, workspaceFolder: string): string {
        path = path.replace("${workspaceFolder}", workspaceFolder);
        path = path.replace("${workspaceRoot}", workspaceFolder); //Deprecated but might still be used.
        return path;
    }

    private getWorkspaceFolder(): string {
        const folders = workspace.workspaceFolders;
        if (!folders || folders.length == 0)
            return '';
        const uri = folders[0].uri;
        return uri.fsPath;
    }

    private static getTestName(lineResult: string): string {
        return lineResult.substring(12).trim().split(' ')[0].replace(',', '');
    }

    public async loadTestsRootAsync() {
        var dummy = new TestNode(undefined, "", "Tests");
        var configs = this.getTestsConfig();
        if (configs) {
            for (var i = 0; i < configs.length; i++) {
                var root = await this.loadTestsRootForConfigAsync(configs[i]);
                if (root)
                    dummy.addChild(root);
            }
        }
        if  (dummy.children.length > 0)
            return dummy;
    }

    private loadTestsRootForConfigAsync(config: TestConfig) {
        var filename = 'tmp' + Math.floor(1000000 * Math.random()) + Date.now() + '.json';
        filename = join(tmpdir(), filename);
        return this.loadTestLines(config, filename).then((fullNames: string[]) => {
            if (fullNames.length == 0) {
                if (existsSync(filename)) {
                    unlinkSync(filename);
                }
                return undefined;
            }
            return this.loadTestsRoot(config.name, fullNames, filename);
        });
    }

    private loadTestLines(config: TestConfig, filename: string): Thenable<string[]> {
        return new Promise((c, e) => {
            var results = execSync(config.program + '  --gtest_list_tests --gtest_output=json:' + filename, { encoding: "utf8", env: config.env })
                .split(/[\r\n]+/g);
            results = results.filter(s => s != null && s.trim() != "" 
                && !s.startsWith("Running main(") &&!s.startsWith("Finished running"));
            c(results);
            return c([]);
        });
    }

    private loadTestsRoot(configname: string, tests: string[], filename: string): TestNode {
        var root = new TestNode(undefined, "", configname);
        var current = root;
        var currentName = "";
        for (var i = 0; i < tests.length; ++i) {
            var currentTestLine = tests[i];
            if (currentTestLine.startsWith(" ")) {
                var indexOfSlash = currentTestLine.indexOf("/");
                if (indexOfSlash > 0) {
                    var startOfLine = currentTestLine.substring(0, indexOfSlash);
                    var testGroupNode = current.addChild(new TestNode(current, currentName, startOfLine));
                    testGroupNode.addChild(new TestNode(current, currentName, currentTestLine));
                } else {
                    current.addChild(new TestNode(current, currentName, currentTestLine));
                }
            } else {
                var indexOfSlash = currentTestLine.indexOf("/");
                if (indexOfSlash > 0) {
                    var startOfLine = currentTestLine.substring(0, indexOfSlash + 1);
                    var first = new TestNode(root, "", startOfLine);
                    var firstNode = root.addChild(first);
                    var second = new TestNode(firstNode, startOfLine, currentTestLine.substring(indexOfSlash + 1));
                    current = firstNode.addChild(second);
                    currentName = currentTestLine;
                } else {
                    var node = new TestNode(root, "", currentTestLine);
                    current = root.addChild(node);
                    currentName = currentTestLine;
                }
            }
        }
        if (existsSync(filename)) {
            workspace.getConfiguration().update("gtest-adapter.supportLocation", true, ConfigurationTarget.Workspace);

            var content = require(filename) as JsonEntry;
            var locations = new Map<string, TestLocation>();
            content.testsuites.forEach(testSuite => {
                testSuite.testsuite.forEach(test => {
                    var fullName = testSuite.name + '.' + test.name;
                    var location = new TestLocation(test.file, test.line);
                    locations.set(fullName, location);
                })
            });

            this.fillLeaves(root, locations);

            unlinkSync(filename);
        } else {
            workspace.getConfiguration().update("gtest-adapter.supportLocation", false, ConfigurationTarget.Workspace);
        }
        this.controller.notifyTreeLoaded(root);
        return root;
    }

    private fillLeaves(root: TestNode, locations: Map<string, TestLocation>) {
        var children = root.children;
        if (children.length == 0) {
            root.location = locations.get(root.fullName);
        } else {
            children.forEach(child => this.fillLeaves(child, locations));
        }
    }
}


const regexPathAndLine = /^([a-zA-Z]:\\|\\\\|\\|\/\/|\/)?([^ \/\\\?\*:]+(\\|\/))*[^ \/\\\?\*:]+\(\d+\)/g;

interface CppDebugConfig extends DebugConfiguration {
    program: string;
    args?: string[];
    environment?:any[];
    cwd?: string;
}

class TestConfig {
    constructor (public name: string, public program: string, public env: any, public cwd: string) {
    }
}